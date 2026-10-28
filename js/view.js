/* Draws the graph as SVG, animates nodes/edges and shows the conversation as bubbles. Knows nothing about the runtime. */
(function (LG) {
  "use strict";
  const NS = "http://www.w3.org/2000/svg";
  const W = 206;
  const H = 84;

  const NODES = {
    user: { x: 58, y: 300, actor: true, label: "usuário" },
    __start__: { x: 150, y: 300, terminal: true, label: "START" },
    triage: { x: 320, y: 300, icon: "bot", label: "triage", sub: "decide a rota" },
    support: { x: 610, y: 130, icon: "wrench", label: "support", sub: "especialista" },
    catalog: { x: 610, y: 450, icon: "package", label: "catalog", sub: "especialista" },
    confirm: { x: 880, y: 530, icon: "userCheck", label: "confirm", sub: "humano · interrupt()", human: true },
    __end__: { x: 915, y: 300, terminal: true, label: "END" },
  };

  // fixed = add_edge (solid) · dynamic = chosen at runtime (dashed) · lane = the user's side, shown only while in use
  const EDGES = {
    "user->__start__": { d: "M 84 300 L 132 300", kind: "lane" },
    "__start__->triage": { d: "M 168 300 L 220 300", kind: "fixed" },
    "triage->support": { d: "M 424 282 C 480 282, 455 130, 505 130", kind: "dynamic", label: "Command(goto)", lx: 470, ly: 196 },
    "triage->catalog": { d: "M 424 318 C 480 318, 455 450, 505 450", kind: "dynamic", label: "Command(goto)", lx: 470, ly: 412 },
    "support->__end__": { d: "M 714 130 C 820 130, 860 230, 902 286", kind: "fixed", label: "add_edge", lx: 838, ly: 170 },
    "catalog->__end__": { d: "M 714 438 C 810 438, 870 360, 906 316", kind: "dynamic" },
    "catalog->confirm": { d: "M 714 464 C 800 464, 880 458, 880 486", kind: "dynamic" },
    "confirm->catalog": { d: "M 776 548 C 690 548, 610 540, 610 494", kind: "dynamic", label: "Command(goto)", lx: 690, ly: 527 },
    "__end__->user": { d: "M 915 280 C 915 -45, 58 -45, 58 274", kind: "lane" },
    "confirm->user": { d: "M 880 574 C 880 612, 58 612, 58 328", kind: "lane human" },
    "user->confirm": { d: "M 58 328 C 58 612, 880 612, 880 574", kind: "lane human" },
  };

  const el = (tag, attrs = {}, parent) => {
    const node = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    if (parent) parent.appendChild(node);
    return node;
  };
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

  class GraphView {
    constructor(svg) {
      this.svg = svg;
      this.nodes = {};
      this.edges = {};
      this.draw();
    }

    draw() {
      const svg = this.svg;
      svg.setAttribute("viewBox", "0 0 1000 600");
      el("defs", {}, svg).innerHTML = `
        <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" class="arrow-head"/></marker>
        <marker id="arrow-hot" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" class="arrow-head hot"/></marker>`;

      const edgeLayer = el("g", { class: "edges" }, svg);
      for (const [key, e] of Object.entries(EDGES)) {
        const g = el("g", { class: `edge ${e.kind}`, "data-edge": key }, edgeLayer);
        const path = el("path", { d: e.d, class: "edge-line", "marker-end": "url(#arrow)" }, g);
        if (e.label) {
          const t = el("text", { x: e.lx, y: e.ly, class: "edge-label", "text-anchor": "middle" }, g);
          t.textContent = e.label;
        }
        this.edges[key] = { g, path };
      }

      // the conversation lives in the top-left corner, above the user
      const fo = el("foreignObject", { x: 10, y: 6, width: 370, height: 250 }, svg);
      this.bubbles = document.createElement("div");
      this.bubbles.className = "bubbles";
      fo.appendChild(this.bubbles);

      this.tokenLayer = el("g", { class: "tokens" }, svg);
      const nodeLayer = el("g", { class: "nodes" }, svg);
      for (const [name, n] of Object.entries(NODES)) {
        const g = el("g", { class: `node ${n.terminal ? "terminal" : ""} ${n.human ? "human" : ""} ${n.actor ? "actor" : ""}`, "data-node": name }, nodeLayer);
        if (n.actor) {
          el("circle", { cx: n.x, cy: n.y, r: 26, class: "node-box" }, g);
          const icon = el("g", { transform: `translate(${n.x - 12} ${n.y - 12})`, fill: "none", stroke: "currentColor", "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round", class: "actor-icon" }, g);
          icon.innerHTML = LG.iconPaths.user;
          const t = el("text", { x: n.x, y: n.y + 46, class: "terminal-label", "text-anchor": "middle" }, g);
          t.textContent = n.label;
        } else if (n.terminal) {
          el("circle", { cx: n.x, cy: n.y, r: 18, class: "node-box" }, g);
          const t = el("text", { x: n.x, y: n.y + 40, class: "terminal-label", "text-anchor": "middle" }, g);
          t.textContent = n.label;
        } else {
          g.setAttribute("transform", `translate(${n.x - W / 2} ${n.y - H / 2})`);
          el("rect", { width: W, height: H, rx: 18, class: "node-box" }, g);
          const icon = el("g", { transform: "translate(18 22)", class: "node-icon" }, g);
          icon.innerHTML = `<rect x="-6" y="-6" width="36" height="36" rx="10" class="icon-bg"/>` +
            `<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${LG.iconPaths[n.icon]}</g>`;
          el("text", { x: 68, y: 38, class: "node-title" }, g).textContent = n.label;
          el("text", { x: 68, y: 61, class: "node-sub" }, g).textContent = n.sub;
          const badge = el("g", { class: "node-badge", transform: `translate(${W - 20} 20)` }, g);
          el("circle", { r: 11 }, badge);
          el("g", { transform: "translate(-6 -6) scale(0.5)", fill: "none", stroke: "currentColor", "stroke-width": 3, "stroke-linecap": "round" }, badge).innerHTML = LG.iconPaths.pause;
        }
        this.nodes[name] = g;
      }
    }

    setStatus(name, status) {
      const g = this.nodes[name];
      if (!g) return;
      g.classList.remove("scheduled", "running", "paused", "error", "done");
      if (status) g.classList.add(status);
    }

    reset() {
      for (const name of Object.keys(this.nodes)) this.setStatus(name, null);
      for (const e of Object.values(this.edges)) e.g.classList.remove("hot", "send");
      this.tokenLayer.innerHTML = "";
    }

    /* ---------- conversation bubbles ---------- */
    _bubble(b) {
      const div = document.createElement("div");
      div.className = `bubble ${b.who}`;
      div.innerHTML = (b.agent ? `<span class="bubble-agent">${esc(b.agent)}</span>` : "") + esc(b.text);
      return div;
    }
    addBubble(b) {
      const div = this._bubble(b);
      this.bubbles.appendChild(div);
      div.animate([{ opacity: 0, transform: "translateY(10px) scale(.97)" }, { opacity: 1, transform: "none" }], { duration: 320, easing: "cubic-bezier(.2,.8,.2,1)" });
      while (this.bubbles.children.length > 4) this.bubbles.firstElementChild.remove();
    }
    setBubbles(list) {
      this.bubbles.innerHTML = "";
      list.slice(-4).forEach((b) => this.bubbles.appendChild(this._bubble(b)));
    }

    /* A token travels along an edge; resolves when it arrives. */
    travel(from, to, { label = "", kind = "", duration = 700 } = {}) {
      const edge = this.edges[`${from}->${to}`];
      if (!edge) return Promise.resolve();
      edge.g.classList.add("hot");
      if (kind === "send") edge.g.classList.add("send");
      edge.path.setAttribute("marker-end", "url(#arrow-hot)");
      const total = edge.path.getTotalLength();
      const token = el("g", { class: `token ${kind}` }, this.tokenLayer);
      el("circle", { r: 7 }, token);
      if (label) {
        const tw = label.length * 7.4 + 16;
        el("rect", { x: -tw / 2, y: -30, width: tw, height: 20, rx: 10, class: "token-tag" }, token);
        el("text", { y: -16, "text-anchor": "middle", class: "token-text" }, token).textContent = label;
      }
      return new Promise((resolve) => {
        const t0 = performance.now();
        const frame = (now) => {
          const u = Math.min(1, (now - t0) / duration);
          const k = u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;
          const p = edge.path.getPointAtLength(total * k);
          token.setAttribute("transform", `translate(${p.x} ${p.y})`);
          if (u < 1) requestAnimationFrame(frame);
          else {
            token.remove();
            setTimeout(() => {
              edge.g.classList.remove("hot", "send");
              edge.path.setAttribute("marker-end", "url(#arrow)");
            }, 450);
            resolve();
          }
        };
        requestAnimationFrame(frame);
      });
    }
  }

  LG.GraphView = GraphView;
})(window.LG);
