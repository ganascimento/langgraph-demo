/* Wires the runtime (engine.js + desk.js) to the screen and plays the guided simulation.
   Every visual change inside a run comes from a runtime event. */
(function (LG) {
  "use strict";
  const { Command, END, START } = LG;
  const $ = (sel) => document.querySelector(sel);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const names = (tasks) => tasks.map((t) => t.node).filter((n) => n !== END);
  const clone = (v) => JSON.parse(JSON.stringify(v));

  const BEAT = 900; // ms per runtime event
  const SPEED = Number(new URLSearchParams(location.search).get("speed")) || 1; // ?speed=4 for quick checks
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms / SPEED));
  const beat = (factor = 1) => sleep(BEAT * factor);
  const travelMs = () => 850 / SPEED;

  const MSG_PRINTER = "Minha impressora está borrando";
  const MSG_SOFTWARE = "Quero o Adobe Acrobat Pro";
  const MSG_BOTH = "A impressora está borrando e qual o prazo de um notebook novo?";

  const ui = { saver: null, graph: null, view: null, threadNo: 1, running: false, live: null, viewing: null, reducerOff: false, turnStart: 0 };
  const threadId = () => `ana/${ui.threadNo}`;
  const EMPTY = { messages: [], active: null, pending: null, tool_result: null };

  /* ---------- bubbles from the state ---------- */
  function bubblesFrom(values, interrupt) {
    const list = values.messages.map((m) => (m.role === "user" ? { who: "user", text: m.content } : { who: "bot", agent: m.agent, text: m.content }));
    if (interrupt) list.push({ who: "question", agent: "confirm · interrupt()", text: interrupt.value.question });
    return list;
  }

  /* ---------- state panel ---------- */
  function fmt(name, value) {
    if (name === "messages") {
      if (!value.length) return `<span class="null">[]</span>`;
      return `<ol class="msg-list">${value
        .map((m) => `<li><span class="msg-role">${esc(m.role === "user" ? "user" : m.agent)}</span>${esc(m.content.slice(0, 40))}${m.content.length > 40 ? "…" : ""}</li>`)
        .join("")}</ol>`;
    }
    if (value === null || value === undefined) return `<span class="null">null</span>`;
    return `<code>${esc(JSON.stringify(value))}</code>`;
  }

  function renderState(values, next, { flash = null, delta = "" } = {}) {
    $("#state-body").innerHTML = Object.entries(LG.CHANNELS)
      .map(([name, ch]) => {
        const off = name === "messages" && ui.reducerOff;
        const reducer = ch.reducer && !off ? "append" : "overwrite";
        return `
        <div class="channel ${flash === name ? "flash" : ""} ${off ? "no-reducer" : ""}">
          <div class="channel-head">
            <span class="channel-name">${name}</span>
            <span class="reducer-badge ${reducer}">${reducer}</span>
            ${off ? `<span class="reducer-off">sem reducer</span>` : ""}
            ${flash === name && delta ? `<span class="delta">${esc(delta)}</span>` : ""}
          </div>
          <div class="channel-value">${fmt(name, values[name])}</div>
        </div>`;
      })
      .join("");
    $("#state-next").innerHTML = next ? `next: <b>${esc(names(next).join(", ") || "END")}</b>` : "";
  }

  /* ---------- checkpoint tape ---------- */
  function tapeCard(cp) {
    const paused = !!cp.interrupt;
    return `
      <button class="cp ${cp.source} ${paused ? "paused" : ""}" data-cp="${cp.id}" title="Ver o estado deste checkpoint">
        <span class="cp-top">#${cp.id}<span class="cp-source">${cp.source}</span>${paused ? LG.icon("pause", 13, "cp-pause") : ""}</span>
        <span class="cp-step">step ${cp.step}</span>
        <span class="cp-next">next: ${esc(names(cp.next).join(", ") || "END")}</span>
      </button>`;
  }
  function renderTape() {
    const list = ui.saver.list(threadId());
    $("#tape").innerHTML = list.length ? list.map(tapeCard).join("") : `<p class="tape-empty">Nenhum checkpoint nesta thread ainda.</p>`;
    $("#tape-count").textContent = list.length;
    bindTape();
  }
  function addTapeCard(cp) {
    $("#tape .tape-empty")?.remove();
    $("#tape").insertAdjacentHTML("beforeend", tapeCard(cp));
    $("#tape-count").textContent = cp.id + 1;
    const card = $("#tape").lastElementChild;
    card.animate([{ opacity: 0, transform: "translateY(10px) scale(.96)" }, { opacity: 1, transform: "none" }], { duration: 380, easing: "cubic-bezier(.2,.8,.2,1)" });
    $("#tape").scrollTo({ left: $("#tape").scrollWidth, behavior: "smooth" });
    bindTape();
  }
  function bindTape() {
    $("#tape").querySelectorAll(".cp").forEach((b) => (b.onclick = () => viewCheckpoint(Number(b.dataset.cp))));
  }
  function viewCheckpoint(id) {
    if (ui.running || !ui.saver) return;
    const cp = ui.saver.list(threadId())[id];
    ui.viewing = cp;
    $("#tape").querySelectorAll(".cp").forEach((b) => b.classList.toggle("viewing", Number(b.dataset.cp) === id));
    $("#travel-banner").hidden = false;
    $("#travel-text").textContent = `Checkpoint #${id} (step ${cp.step}) · só leitura`;
    renderState(cp.values, cp.next);
  }
  function backToLive() {
    ui.viewing = null;
    $("#travel-banner").hidden = true;
    $("#tape").querySelectorAll(".cp").forEach((b) => b.classList.remove("viewing"));
    renderState(ui.live, ui.saver.latest(threadId())?.next || null);
  }

  /* ---------- runtime events → screen ---------- */
  async function handle(e) {
    switch (e.type) {
      case "checkpoint":
        addTapeCard(e.checkpoint);
        renderState(ui.live, e.checkpoint.next);
        return beat(0.7);
      case "superstep": {
        $("#superstep").textContent = `super-step ${e.step}`;
        const ns = names(e.tasks);
        ns.forEach((n) => ui.view.setStatus(n, ns.length > 1 ? "running" : "scheduled"));
        return ns.length > 1 ? beat(1.2) : undefined;
      }
      case "task_start":
        ui.view.setStatus(e.node, "running");
        if (e.send) return;
        return beat(e.rerun ? 1.4 : 0.9);
      case "log":
        return; // node logs are not drawn
      case "task_end": {
        ui.view.setStatus(e.node, "done");
        const sends = e.routes.filter((r) => r.send);
        if (sends.length) {
          await Promise.all(sends.map((s) => ui.view.travel(e.node, s.node, { label: "Send", kind: "send", duration: travelMs() })));
          return beat(0.4);
        }
        await ui.view.travel(e.node, e.routes[0]?.node, { label: e.command ? "Command" : "", duration: travelMs() });
        return beat(0.3);
      }
      case "write": {
        ui.live[e.channel] = e.after;
        const delta = e.reducer === "append" ? `+${e.after.length - (e.before || []).length} append` : `← ${e.from[0]}`;
        renderState(ui.live, null, { flash: e.channel, delta });
        return beat(e.channel === "messages" && e.from.length > 1 ? 1.3 : 0.5);
      }
      case "interrupt": {
        ui.view.setStatus(e.node, "paused");
        const card = $(`#tape .cp[data-cp="${e.checkpoint.id}"]`);
        if (card) {
          card.outerHTML = tapeCard(e.checkpoint);
          bindTape();
          $(`#tape .cp[data-cp="${e.checkpoint.id}"]`).animate([{ boxShadow: "0 0 0 6px rgba(244,114,182,.45)" }, { boxShadow: "0 0 0 0 transparent" }], { duration: 900 });
        }
        await ui.view.travel("confirm", "user", { label: "interrupt", kind: "human", duration: travelMs() * 1.4 });
        ui.view.addBubble({ who: "question", agent: "confirm · interrupt()", text: e.value.question });
        return beat(1.2);
      }
      case "resume":
        await ui.view.travel("user", "confirm", { label: "Command(resume)", kind: "human", duration: travelMs() * 1.4 });
        return beat(0.6);
      case "error":
        ["support", "catalog"].forEach((n) => ui.view.setStatus(n, "error"));
        ui.live = clone(ui.saver.latest(threadId()).values); // the failed step left nothing behind
        renderState(ui.live, null);
        ui.view.addBubble({ who: "error", agent: e.name, text: "Dois nós escreveram em messages no mesmo super-step, sem reducer." });
        return beat(3);
      case "done": {
        ui.view.setStatus(END, "done");
        const answers = ui.live.messages.slice(ui.turnStart).filter((m) => m.role === "assistant");
        if (answers.length) {
          await ui.view.travel(END, "user", { label: "resposta", duration: travelMs() * 1.5 });
          answers.forEach((m) => ui.view.addBubble({ who: "bot", agent: m.agent, text: m.content }));
        }
        return beat(2.2);
      }
    }
  }

  /* ---------- running ---------- */
  async function run(input) {
    ui.running = true;
    ui.turnStart = ui.live.messages.length;
    ui.view.reset();
    try {
      for await (const e of ui.graph.stream(input, { threadId: threadId() })) await handle(e);
    } finally {
      ui.running = false;
    }
  }

  async function say(text) {
    ui.view.addBubble({ who: "user", text });
    await beat(0.8);
    await ui.view.travel("user", START, { label: "mensagem", duration: travelMs() });
    await run({ messages: [{ role: "user", content: text }] });
  }

  async function answer(text) {
    ui.view.addBubble({ who: "user", text });
    await beat(0.8);
    // the answer is not a message in the state: it travels as Command(resume=...)
    await run(new Command({ resume: text }));
  }

  /* ---------- boot / crash ---------- */
  function boot() {
    ui.saver = new LG.Saver();
    ui.graph = LG.buildDesk(ui.saver);
    if (ui.reducerOff) ui.graph.disabledReducers.add("messages");
    ui.view.reset();
    ui.viewing = null;
    $("#travel-banner").hidden = true;
    $("#thread-id").textContent = threadId();
    $("#superstep").textContent = "parado";
    const last = ui.saver.latest(threadId());
    ui.live = last ? clone(last.values) : clone(EMPTY);
    ui.view.setBubbles(bubblesFrom(ui.live, last?.interrupt));
    renderState(ui.live, last ? last.next : null);
    renderTape();
    if (last?.interrupt) ui.view.setStatus(last.interrupt.node, "paused");
  }

  async function crash() {
    const cpId = ui.saver.latest(threadId()).id;
    $("#crash-warn").hidden = false;
    await beat(2.2);
    $("#crash-warn").hidden = true;

    $("#crash-steps").innerHTML = "";
    $("#crash-bar").hidden = true;
    $("#crash-shade").hidden = false;
    // drop every object in memory: graph, saver and everything drawn; only the checkpointer's storage survives
    ui.graph = null;
    ui.saver = null;
    ui.view.setBubbles([]);
    ui.view.reset();
    $("#state-body").innerHTML = "";
    $("#tape").innerHTML = "";

    const steps = [
      ["lost", "x", "grafo, nós e conexões em memória: <b>apagados</b>"],
      ["lost", "x", "a conversa desenhada na tela: <b>apagada</b>"],
      ["kept", "database", `checkpoint #${cpId} da thread ${threadId()}: <b>salvo no disco</b>`],
    ];
    await beat(1);
    for (const [kind, icon, html] of steps) {
      $("#crash-steps").insertAdjacentHTML("beforeend", `<li class="${kind}">${LG.icon(icon, 18)}<span>${html}</span></li>`);
      await beat(1.3);
    }
    $("#crash-bar").hidden = false;
    $("#crash-steps").insertAdjacentHTML("beforeend", `<li class="boot">${LG.icon("rotate", 18)}<span>subindo de novo e lendo o checkpoint…</span></li>`);
    await beat(1.8);
    $("#crash-shade").hidden = true;

    boot();
    $("#restored").hidden = false;
    $("#restored-text").textContent = `restaurado do checkpoint #${cpId} · a pausa continua esperando o "sim"`;
    await beat(3.5);
    $("#restored").hidden = true;
  }

  function newThread() {
    ui.threadNo += 1;
    boot();
  }

  /* ---------- the guided simulation ---------- */
  async function chapter(i) {
    document.querySelectorAll(".chapter").forEach((c, k) => {
      c.classList.toggle("active", k === i);
      c.classList.toggle("past", k < i);
    });
    await beat(1.2);
  }

  async function simulate() {
    const btn = $("#start-btn");
    btn.disabled = true;
    btn.innerHTML = `${LG.icon("workflow", 16)} Simulando…`;
    ui.saver.clear();
    ui.threadNo = 0;
    ui.reducerOff = false;
    document.querySelectorAll(".chapter").forEach((c) => c.classList.remove("active", "past"));
    try {
      await chapter(0);
      newThread();
      await say(MSG_PRINTER);

      await chapter(1);
      newThread();
      await say(MSG_SOFTWARE);
      await beat(1.5);
      await crash();
      await answer("sim");

      await chapter(2);
      newThread();
      await say(MSG_BOTH);

      await chapter(3);
      newThread();
      ui.reducerOff = true;
      ui.graph.disabledReducers.add("messages");
      renderState(ui.live, null, { flash: "messages", delta: "reducer removido" });
      await beat(1.8);
      await say(MSG_BOTH);

      document.querySelectorAll(".chapter").forEach((c) => c.classList.replace("active", "past"));
    } catch (err) {
      console.error(err);
    }
    ui.reducerOff = false;
    btn.disabled = false;
    btn.innerHTML = `${LG.icon("rotate", 16)} Rodar de novo`;
  }

  function init() {
    ui.view = new LG.GraphView($("#graph"));
    new LG.Saver().clear();
    boot();
    $("#start-btn").addEventListener("click", simulate);
    $("#travel-back").addEventListener("click", backToLive);
    if (new URLSearchParams(location.search).has("autoplay")) setTimeout(simulate, 600 / SPEED);
  }

  document.addEventListener("DOMContentLoaded", init);
})(window.LG);
