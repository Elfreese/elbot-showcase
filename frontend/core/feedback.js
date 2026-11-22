export function createFeedback({ notify }) {
  // 已有二元结果的动作用 done。
  function done(ok, { okText, failText = "操作失败", failLevel = "WARN" } = {}) {
    notify(ok ? "SUCCESS" : failLevel, ok ? okText : failText);
  }

  return { done };
}
