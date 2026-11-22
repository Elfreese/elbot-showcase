import { copyText } from "./dom.js";

// 把复制结果转成用户可见的反馈；剪贴板细节仍留在 dom.js。
export function createClipboard({ feedback }) {
  async function copy(text, button, okText = "已复制") {
    const copied = await copyText(text, button);
    feedback.done(copied, { okText, failText: "复制失败：剪贴板不可用，请手动选中文本复制" });
    return copied;
  }

  return { copy };
}
