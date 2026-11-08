import { element, icon, iconButton, formatBytes } from "../core/dom.js";

export function createAttachments({ ui, state, nearBottom, scrollBottom, updateControls, hideCompletion, showLogin, addNotice }) {
  function makeFileItem(local, media = null) {
    const item = { local, media, generation: state.generation, draft: !!local, status: media ? "ready" : "waiting",
      progress: 0, xhr: null, blobURL: null, loading: false, error: "", card: element("div", "file-card") };
    state.fileItems.add(item);
    renderFileCard(item);
    return item;
  }

  function previewable(mime) {
    return /^image\/(png|jpeg|gif|webp|avif|bmp)$/i.test(mime);
  }

  function renderFileCard(item) {
    const follow = nearBottom();
    const name = item.media?.name || item.local?.name || "文件";
    const size = item.media?.size ?? item.local?.size ?? 0;
    const current = item.generation === state.generation && state.ready;
    item.card.replaceChildren();
    if (item.blobURL && previewable(item.media?.mime_type)) {
      const image = document.createElement("img");
      image.className = "file-preview";
      image.src = item.blobURL;
      image.alt = name;
      item.card.append(image);
      image.addEventListener("load", () => { if (follow) scrollBottom(); }, { once: true });
    }
    const main = element("div", "file-card-main");
    const details = element("div", "file-details");
    const nameLabel = element("span", "file-name", name);
    nameLabel.title = name;
    let label = formatBytes(size);
    if (item.draft) {
      if (item.status === "uploading") label += ` · 上传 ${item.progress}%`;
      else if (item.status === "waiting") label += " · 等待连接";
      else if (item.status === "error") label += ` · ${item.error}`;
    } else if (!current && !item.blobURL) label += " · 附件已失效";
    details.append(nameLabel, element("span", "file-meta", label));
    const buttons = element("div", "file-buttons");
    if (item.draft) {
      if (item.status === "error") {
        const retry = element("button", "file-retry", "重试");
        retry.type = "button";
        retry.disabled = !state.ready;
        retry.addEventListener("click", () => uploadFile(item));
        buttons.append(retry);
      }
      buttons.append(iconButton("close", "移除附件", () => removeDraftFile(item)));
    } else {
      const download = iconButton("download", item.loading ? "获取中…" : "下载附件", () => loadFile(item, false));
      download.disabled = item.loading || (!current && !item.blobURL);
      buttons.append(download);
    }
    main.append(icon("file"), details, buttons);
    item.card.append(main);
    if (item.draft && item.status === "uploading") {
      const progress = element("div", "file-progress");
      const bar = element("span");
      bar.style.width = `${item.progress}%`;
      progress.append(bar);
      item.card.append(progress);
    }
  }

  function renderDraftFiles() {
    ui["draft-files"].replaceChildren(...state.draftFiles.map(item => item.card));
    ui["draft-files"].hidden = !state.draftFiles.length;
    updateControls();
  }

  function addFiles(files) {
    if (!state.ready) { showLogin(); return; }
    for (const file of files) {
      const item = makeFileItem(file);
      state.draftFiles.push(item);
      uploadFile(item);
    }
    renderDraftFiles();
  }

  function uploadFile(item) {
    if (!state.ready || !item.local) return;
    const generation = state.generation;
    item.generation = generation;
    item.status = "uploading";
    item.error = "";
    item.progress = 0;
    const xhr = new XMLHttpRequest();
    item.xhr = xhr;
    xhr.open("POST", "/cli/v1/files");
    xhr.setRequestHeader("Authorization", `Bearer ${state.mediaToken}`);
    xhr.timeout = 120000;
    xhr.responseType = "json";
    const update = () => { renderFileCard(item); updateControls(); };
    const failed = text => {
      if (generation !== state.generation || !state.fileItems.has(item)) return;
      item.status = state.ready ? "error" : "waiting";
      item.error = text;
      item.xhr = null;
      update();
    };
    xhr.upload.addEventListener("progress", event => {
      if (generation !== state.generation) return;
      item.progress = event.lengthComputable ? Math.round(100 * event.loaded / event.total) : 0;
      update();
    });
    xhr.addEventListener("load", () => {
      if (generation !== state.generation || !state.fileItems.has(item)) return;
      if (xhr.status !== 201) { failed(xhr.status === 401 ? "连接已失效" : "上传失败"); return; }
      item.media = xhr.response;
      item.status = "ready";
      item.xhr = null;
      update();
    });
    xhr.addEventListener("error", () => failed("网络错误"));
    xhr.addEventListener("timeout", () => failed("上传超时"));
    xhr.addEventListener("abort", () => failed("上传已取消"));
    const data = new FormData();
    data.append("file", item.local);
    xhr.send(data);
    update();
  }

  function removeDraftFile(item) {
    state.draftFiles = state.draftFiles.filter(file => file !== item);
    state.fileItems.delete(item);
    item.xhr?.abort();
    if (item.blobURL) URL.revokeObjectURL(item.blobURL);
    if (item.media && item.generation === state.generation && state.ready) {
      fetch(`/cli/v1/files/${encodeURIComponent(item.media.id)}`, {
        method: "DELETE", headers: { Authorization: `Bearer ${state.mediaToken}` }, signal: state.http.signal,
      }).catch(() => {}); // 断连时服务端也会释放该连接的附件授权。
    }
    hideCompletion();
    renderDraftFiles();
  }

  async function loadFile(item, preview) {
    if (item.loading) return;
    const generation = state.generation;
    item.loading = true;
    renderFileCard(item);
    try {
      if (!item.blobURL) {
        const response = await fetch(`/cli/v1/files/${encodeURIComponent(item.media.id)}`, {
          headers: { Authorization: `Bearer ${state.mediaToken}` }, signal: state.http.signal,
        });
        if (!response.ok) throw new Error(response.status === 404 ? "附件已失效" : "附件获取失败");
        const blob = await response.blob();
        if (generation !== state.generation || !state.fileItems.has(item)) return;
        item.blobURL = URL.createObjectURL(blob);
      }
      if (!preview) {
        const link = document.createElement("a");
        link.href = item.blobURL;
        link.download = item.media.name;
        document.body.append(link);
        link.click();
        link.remove();
      }
    } catch (error) {
      if (error.name !== "AbortError" && generation === state.generation) addNotice("ERROR", error.message);
    } finally {
      item.loading = false;
      if (state.fileItems.has(item)) renderFileCard(item);
    }
  }

  return { makeFileItem, previewable, renderFileCard, renderDraftFiles, addFiles, uploadFile, removeDraftFile, loadFile };
}
