/*
 * The demo graph: a tiny service desk.
 * The "LLM" decisions are scripted (keyword rules) so the demo runs offline and always the same way;
 * everything else (state, reducers, routing, checkpoints, interrupt) goes through the runtime in engine.js.
 */
(function (LG) {
  "use strict";
  const { Command, Send, StateGraph, END, append } = LG;

  const CHANNELS = {
    messages: { reducer: append, reducerName: "append", default: [] },
    active: { default: null },
    pending: { default: null },
    tool_result: { default: null },
  };

  const PRINTER = /impressora|printer|borr|imprim/i;
  const LAPTOP = /notebook|laptop|computador/i;
  const SOFTWARE = /acrobat|software|programa|licen|photoshop|office/i;

  const lastUser = (state) => [...state.messages].reverse().find((m) => m.role === "user")?.content || "";
  const reply = (agent, content) => ({ role: "assistant", agent, content });
  const isYes = (text) => /^\s*(sim|s|yes|y|ok|pode|confirmo)[\s.!]*$/i.test(text);

  function triage(state, ctx) {
    const text = lastUser(state);
    const printer = PRINTER.test(text);
    const laptop = LAPTOP.test(text);
    const software = SOFTWARE.test(text);
    if (printer && (laptop || software)) {
      ctx.log("Dois pedidos independentes: um Send para cada especialista.");
      return new Command({
        update: { active: "triage" },
        goto: [new Send("support", { request: "printer" }), new Send("catalog", { request: "laptop_eta" })],
      });
    }
    if (printer) return new Command({ update: { active: "support" }, goto: "support" });
    if (software || laptop) return new Command({ update: { active: "catalog" }, goto: "catalog" });
    return { messages: [reply("triage", "Posso ajudar com impressora, software ou equipamento. O que aconteceu?")] };
  }

  function support(input) {
    return {
      messages: [
        reply("support", "Faça a limpeza do cabeçote: Configurações > Manutenção > Limpeza (KB003). Se continuar borrando, eu abro um chamado."),
      ],
    };
  }

  function catalog(input, ctx) {
    if (input.request === "laptop_eta" || (input.messages && LAPTOP.test(lastUser(input)) && !SOFTWARE.test(lastUser(input)))) {
      return { messages: [reply("catalog", "Notebook novo: entrega em até 5 dias úteis depois da aprovação do gestor.")] };
    }
    const state = input;
    if (state.tool_result) {
      const r = state.tool_result;
      const text = r.ok
        ? `Pronto: abri a solicitação ${r.id} do ${r.item}. Agora ela vai para a aprovação do seu gestor.`
        : "Tudo bem, não abri nenhuma solicitação.";
      return { messages: [reply("catalog", text)], tool_result: null, active: null };
    }
    const item = /acrobat/i.test(lastUser(state)) ? "Adobe Acrobat Pro" : "software solicitado";
    ctx.log("O LLM quer chamar request_software (uma escrita): o código segura a chamada e manda para confirmação.");
    return new Command({ update: { pending: { tool: "request_software", args: { item } } }, goto: "confirm" });
  }

  function confirm(state, ctx) {
    const { tool, args } = state.pending;
    ctx.log("Linha 1: monta a pergunta a partir dos argumentos reais (texto escrito pelo código, não pelo LLM).");
    const answer = ctx.interrupt({ question: `Posso abrir a solicitação do ${args.item}?`, tool, args });
    if (isYes(answer)) {
      ctx.log(`Depois do interrupt: executa ${tool} UMA vez.`);
      return new Command({ update: { pending: null, tool_result: { ok: true, id: "REQ0042", item: args.item } }, goto: "catalog" });
    }
    return new Command({ update: { pending: null, tool_result: { ok: false } }, goto: "catalog" });
  }

  function buildDesk(saver) {
    return new StateGraph(CHANNELS)
      .addNode("triage", triage)
      .addNode("support", support)
      .addNode("catalog", catalog)
      .addNode("confirm", confirm)
      .addEdge(LG.START, "triage")
      .addEdge("support", END)
      .compile({ checkpointer: saver });
  }

  LG.buildDesk = buildDesk;
  LG.CHANNELS = CHANNELS;
})(window.LG);
