const $ = (id) => document.getElementById(id);
const editor = $("editor");
const title = $("title");
const scripts = $("scripts");
const startNode = $("start");
const status = $("status");
const diagnostics = $("diagnostics");
const transcript = $("transcript");
const options = $("options");
const variables = $("variables");
const dialog = $("create");
let documentRecord;
let locked = false;
let previewVersion = 0;
let preview = null;

const dirty = () => documentRecord && (editor.value !== documentRecord.source || title.value !== documentRecord.title);
const mayLeave = () => !dirty() || window.confirm("当前脚本有未保存的改动。确定继续？");
function setStatus(text, error = false) {
  status.textContent = text;
  status.classList.toggle("error", error);
}
function updateControls() {
  const open = Boolean(documentRecord);
  for (const id of ["run", "download", "check", "import"]) $(id).disabled = !open || locked;
  $("new").disabled = locked;
  $("save").disabled = !open || locked || !dirty();
  editor.disabled = title.disabled = !open;
  scripts.disabled = locked || !open;
}
async function api(path, method = "GET", body) {
  const response = await fetch("/api" + path, {
    method, ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  const data = await response.json();
  if (response.status === 401) throw new Error("登录已过期。请在新标签页重新登录，然后重试。");
  if (!response.ok) throw new Error(data.error);
  return data;
}
async function task(action) {
  if (locked) return;
  locked = true;
  updateControls();
  try { await action(); } catch (error) { setStatus(error.message, true); }
  finally { locked = false; updateControls(); }
}
function sectionText(tag, value, name = "") {
  const element = document.createElement(tag);
  element.textContent = value;
  if (name) element.className = name;
  return element;
}
function refreshLineNumbers() {
  const count = editor.value.split("\n").length;
  $("gutter").textContent = Array.from({ length: count }, (_, index) => index + 1).join("\n");
  $("position").textContent = `${count} 行 · ${editor.value.length} 字符`;
}
function resetPreview() {
  previewVersion++;
  preview = null;
  options.replaceChildren();
  variables.hidden = true;
  transcript.replaceChildren(sectionText("p", "运行脚本后，可在这里选择剧情分支。", "empty"));
  diagnostics.hidden = true;
}
function goToLine(line) {
  const chars = editor.value.split("\n").slice(0, line - 1).reduce((length, value) => length + value.length + 1, 0);
  editor.focus();
  editor.setSelectionRange(chars, chars);
  editor.scrollTop = Math.max(0, (line - 3) * 25);
}
function showDiagnostics(list = []) {
  diagnostics.hidden = list.length === 0;
  diagnostics.replaceChildren(...list.map((item) => {
    const button = sectionText("button", `第 ${item.line} 行 · ${item.message}`, item.severity);
    button.type = "button";
    button.addEventListener("click", () => goToLine(item.line));
    return button;
  }));
}
function setNodes(nodes) {
  if (!nodes?.length) return;
  const selected = startNode.value;
  startNode.replaceChildren(...nodes.map((name) => new Option(name, name)));
  if (nodes.includes(selected)) startNode.value = selected;
  else if (nodes.includes("Start")) startNode.value = "Start";
}
function readNodeTitles() {
  return [...new Set([...editor.value.matchAll(/^title:\s*(\S[^\r\n]*)/gm)].map((match) => match[1].trim()))];
}
function renderPreview(result, choiceCount) {
  showDiagnostics(result.diagnostics);
  setNodes(result.nodes);
  if (result.error || !result.lines) {
    transcript.replaceChildren(sectionText("p", result.error || "脚本编译失败。查看左侧诊断。", "empty"));
    options.replaceChildren();
    variables.hidden = true;
    setStatus(result.error || "脚本编译失败", true);
    return;
  }
  let previous = "";
  const elements = [];
  for (const line of result.lines) {
    if (line.node !== previous) {
      elements.push(sectionText("p", line.node, "node-name"));
      previous = line.node;
    }
    elements.push(sectionText("p", line.kind === "command" ? `<<${line.text}>>` : line.text, line.kind));
  }
  if (result.complete) elements.push(sectionText("p", "剧情结束", "ending"));
  if (!elements.length) elements.push(sectionText("p", "当前节点没有台词。", "empty"));
  transcript.replaceChildren(...elements);
  if (choiceCount) transcript.scrollTop = transcript.scrollHeight;
  options.replaceChildren(...result.options.map((option) => {
    const button = sectionText("button", option.text, "option");
    button.disabled = !option.available;
    button.type = "button";
    button.addEventListener("click", () => void run(option.id));
    return button;
  }));
  const values = Object.entries(result.variables || {});
  variables.hidden = !values.length;
  $("values").replaceChildren(...values.flatMap(([key, value]) =>
    [sectionText("dt", key), sectionText("dd", JSON.stringify(value))]));
  setStatus(result.complete ? "预览完成" : result.options.some((option) => option.available) ? "等待选择" : "预览停在当前节点");
}
async function run(choice) {
  if (locked) return;
  if (choice === undefined) {
    preview = { source: editor.value, choices: [], startNode: startNode.value,
      seed: globalThis.crypto.getRandomValues(new Uint32Array(1))[0] >>> 1 };
  } else if (!preview) return;
  else preview.choices.push(choice);
  const version = previewVersion;
  const input = preview;
  await task(async () => {
    options.querySelectorAll("button").forEach((button) => { button.disabled = true; });
    setStatus("正在运行 Yarn…");
    try {
      const result = await api("/preview", "POST", input);
      if (version === previewVersion) renderPreview(result, input.choices.length);
    } catch (error) {
      if (version === previewVersion) resetPreview();
      throw error;
    }
  });
}
async function show(id) {
  const record = await api("/scripts/" + id);
  documentRecord = record;
  editor.value = record.source;
  title.value = record.title;
  scripts.value = id;
  history.replaceState(null, "", "/?script=" + id);
  resetPreview();
  startNode.replaceChildren(new Option("Start", "Start"));
  setNodes(readNodeTitles());
  refreshLineNumbers();
  setStatus(`已加载 · v${record.revision}`);
}
async function loadList() {
  const available = await api("/scripts");
  scripts.replaceChildren(...available.map((entry) => new Option(entry.title, entry.id)));
  return available;
}
scripts.addEventListener("change", () => {
  if (!mayLeave()) { scripts.value = documentRecord.id; return; }
  void task(() => show(scripts.value));
});
editor.addEventListener("scroll", () => { $("gutter").scrollTop = editor.scrollTop; });
editor.addEventListener("input", () => {
  resetPreview();
  setNodes(readNodeTitles());
  refreshLineNumbers();
  setStatus("未保存");
  updateControls();
});
title.addEventListener("input", () => { setStatus("未保存"); updateControls(); });
$("save").addEventListener("click", async () => task(async () => {
  const snapshot = { title: title.value.trim(), source: editor.value, revision: documentRecord.revision };
  if (!snapshot.title) { title.focus(); throw new Error("请输入脚本名称"); }
  const saved = await api("/scripts/" + documentRecord.id, "PUT", snapshot);
  documentRecord = saved;
  if (title.value.trim() === snapshot.title) title.value = saved.title;
  scripts.selectedOptions[0].textContent = saved.title;
  setStatus(dirty() ? "已保存刚才的版本，当前还有改动" : `已保存 · v${saved.revision}`);
}));
$("new").addEventListener("click", () => {
  if (!mayLeave()) return;
  $("new-title").value = "";
  dialog.returnValue = "cancel";
  dialog.showModal();
});
dialog.addEventListener("close", () => {
  if (dialog.returnValue !== "submit") return;
  void task(async () => {
    const record = await api("/scripts", "POST", { title: $("new-title").value.trim() });
    await loadList();
    await show(record.id);
  });
});
$("import").addEventListener("click", () => $("file").click());
$("file").addEventListener("change", async () => {
  const file = $("file").files[0];
  $("file").value = "";
  if (!file || !mayLeave()) return;
  if (file.size > 240_000) { setStatus("请选择较小的 .yarn 文件", true); return; }
  const text = await file.text();
  if (text.length > 60_000) { setStatus("脚本上限为 60,000 字符", true); return; }
  editor.value = text;
  editor.dispatchEvent(new Event("input"));
  setStatus("脚本已导入当前草稿");
});
$("download").addEventListener("click", () => {
  const link = document.createElement("a");
  const url = URL.createObjectURL(new Blob([editor.value], { type: "text/plain;charset=utf-8" }));
  link.href = url;
  link.download = (title.value.trim() || "script") + ".yarn";
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 500);
});
$("check").addEventListener("click", () => task(async () => {
  const version = previewVersion;
  const result = await api("/check", "POST", { source: editor.value });
  if (version !== previewVersion) return;
  showDiagnostics(result.diagnostics);
  setNodes(result.nodes);
  const issues = result.diagnostics || [];
  const failed = Boolean(result.error) || issues.some((item) => item.severity === "error");
  setStatus(result.error || (failed ? "编译失败" : issues.length ? "编译通过，有诊断提示" : "编译通过"), failed);
}));
$("run").addEventListener("click", () => void run());
startNode.addEventListener("change", resetPreview);
if (location.protocol === "https:") $("logout").hidden = false;
$("logout").addEventListener("submit", (event) => { if (!mayLeave()) event.preventDefault(); });
window.addEventListener("beforeunload", (event) => { if (dirty()) event.preventDefault(); });
document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
    event.preventDefault();
    $("save").click();
  }
});

await task(async () => {
  const list = await loadList();
  const requested = new URLSearchParams(location.search).get("script");
  if (list.length) await show(list.find(({ id }) => id === requested)?.id || list[0].id);
});
