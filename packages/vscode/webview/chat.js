// SANIX chat webview — bridges the textarea/list with the extension host via
// the VS Code `acquireVsCodeApi()` postMessage protocol.
(function () {
  const vscode = acquireVsCodeApi();
  const messagesEl = document.getElementById("messages");
  const inputEl = document.getElementById("input");
  const sendBtn = document.getElementById("send");
  const stopBtn = document.getElementById("stop");

  if (!messagesEl || !inputEl || !sendBtn || !stopBtn) return;

  const streamingIds = new Set();

  /** Render an entire history (replaces DOM). */
  function renderHistory(messages) {
    messagesEl.innerHTML = "";
    for (const m of messages) {
      appendMessage(m);
    }
    scrollToBottom();
  }

  /** Append a single message card. */
  function appendMessage(m) {
    const div = document.createElement("div");
    div.className = "msg " + m.role;
    if (m.streaming) {
      div.classList.add("streaming");
      streamingIds.add(m.id);
    }
    div.dataset.id = m.id;
    div.innerHTML = renderMarkdown(m.content || "");
    if (m.model || m.costUsd !== undefined) {
      const meta = document.createElement("div");
      meta.className = "meta";
      const parts = [];
      if (m.model) parts.push(m.model);
      if (m.costUsd !== undefined) parts.push("$" + m.costUsd.toFixed(4));
      meta.textContent = parts.join(" · ");
      div.appendChild(meta);
    }
    // If message contains ```diff blocks, add an "Apply Diff" button.
    if (/```diff\n/.test(m.content)) {
      const btn = document.createElement("button");
      btn.className = "apply-btn";
      btn.textContent = "Apply Diff";
      btn.addEventListener("click", () => {
        vscode.postMessage({ type: "applyDiff", messageId: m.id });
      });
      div.appendChild(btn);
    }
    messagesEl.appendChild(div);
  }

  /** Minimal Markdown: fenced code blocks (with diff highlighting) + inline code. */
  function renderMarkdown(text) {
    // Escape HTML first.
    const esc = (s) =>
      s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const blocks = text.split(/(```[\s\S]*?```)/g);
    return blocks
      .map((block) => {
        const fence = block.match(/^```(\w*)\n([\s\S]*?)\n```$/);
        if (fence) {
          const lang = fence[1] || "";
          const body = esc(fence[2] || "");
          const cls = lang === "diff" ? "diff" : "";
          return `<pre class="${cls}">${body}</pre>`;
        }
        // Inline code.
        return esc(block).replace(/`([^`]+)`/g, "<code>$1</code>");
      })
      .join("");
  }

  function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  /** Send the current input box contents to the extension host. */
  function send() {
    const text = inputEl.value.trim();
    if (!text) return;
    vscode.postMessage({ type: "send", text });
    inputEl.value = "";
    sendBtn.disabled = true;
    stopBtn.disabled = false;
  }

  /** Stop an in-flight stream. */
  function stop() {
    vscode.postMessage({ type: "stop" });
    stopBtn.disabled = true;
  }

  // Wire up DOM events.
  sendBtn.addEventListener("click", send);
  stopBtn.addEventListener("click", stop);
  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    } else if (e.key === "Escape") {
      stop();
    }
  });

  // Receive messages from the extension host.
  window.addEventListener("message", (event) => {
    const msg = event.data;
    switch (msg.type) {
      case "history":
        streamingIds.clear();
        renderHistory(msg.messages);
        break;
      case "append": {
        // Append chunk to the existing streaming message.
        const el = messagesEl.querySelector(`.msg[data-id="${msg.id}"] pre`);
        if (el) {
          el.textContent += msg.chunk;
        } else {
          // First chunk — create the message card.
          appendMessage({
            id: msg.id,
            role: "assistant",
            content: msg.chunk,
            ts: Date.now(),
            streaming: true,
          });
        }
        scrollToBottom();
        break;
      }
      case "done": {
        const el = messagesEl.querySelector(`.msg[data-id="${msg.id}"]`);
        if (el) el.classList.remove("streaming");
        streamingIds.delete(msg.id);
        if (streamingIds.size === 0) {
          sendBtn.disabled = false;
          stopBtn.disabled = true;
        }
        break;
      }
      case "error": {
        appendMessage({
          id: msg.id,
          role: "error",
          content: msg.message,
          ts: Date.now(),
        });
        sendBtn.disabled = false;
        stopBtn.disabled = true;
        scrollToBottom();
        break;
      }
      case "clear":
        messagesEl.innerHTML = "";
        streamingIds.clear();
        break;
      case "config":
        // Could be used to theme the webview from settings.
        break;
    }
  });

  // Signal that the webview is ready.
  vscode.postMessage({ type: "ready" });
})();
