/*
 * A minimal Pregel-style runtime with LangGraph semantics, written for teaching.
 * Not LangGraph itself: the same rules, small enough to read in one sitting.
 *
 *  - state = channels; a channel with a reducer merges writes, one without it overwrites
 *  - super-steps: every scheduled task runs, nobody sees the others' writes until the step ends
 *  - a checkpoint is saved after every super-step (state must be JSON-serializable)
 *  - nodes route with Command(goto), fan out with Send, pause with interrupt()
 *  - on resume the interrupted node runs AGAIN from its first line; interrupt() now returns the answer
 */
(function (LG) {
  "use strict";

  const START = "__start__";
  const END = "__end__";

  class Command {
    constructor({ goto = null, update = null, resume } = {}) {
      this.goto = goto;
      this.update = update;
      this.resume = resume;
    }
  }

  class Send {
    constructor(node, arg) {
      this.node = node;
      this.arg = arg;
    }
  }

  class GraphInterrupt extends Error {
    constructor(value) {
      super("GraphInterrupt");
      this.value = value;
    }
  }

  class InvalidUpdateError extends Error {}

  const append = (current, value) => [...(current || []), ...(Array.isArray(value) ? value : [value])];
  const clone = (value) => JSON.parse(JSON.stringify(value)); // also proves the state is serializable

  /* Checkpointer backed by localStorage: it survives a "process restart" (page objects rebuilt). */
  class Saver {
    constructor(key = "langgraph-demo/checkpoints") {
      this.key = key;
      this.memory = {};
    }
    _all() {
      try {
        const raw = localStorage.getItem(this.key);
        return raw ? JSON.parse(raw) : {};
      } catch {
        return this.memory;
      }
    }
    _save(all) {
      try {
        localStorage.setItem(this.key, JSON.stringify(all));
      } catch {
        this.memory = all;
      }
    }
    list(threadId) {
      return this._all()[threadId] || [];
    }
    latest(threadId) {
      const list = this.list(threadId);
      return list[list.length - 1] || null;
    }
    patchLatest(threadId, patch) {
      const all = this._all();
      const list = all[threadId];
      Object.assign(list[list.length - 1], patch);
      this._save(all);
      return list[list.length - 1];
    }
    put(threadId, checkpoint) {
      const all = this._all();
      (all[threadId] ||= []).push(checkpoint);
      this._save(all);
      return checkpoint;
    }
    clear() {
      this._save({});
    }
  }

  class StateGraph {
    constructor(channels) {
      this.channels = channels; // { name: { reducer?, reducerName?, default } }
      this.nodes = {};
      this.edges = {};
    }
    addNode(name, fn) {
      this.nodes[name] = fn;
      return this;
    }
    addEdge(from, to) {
      (this.edges[from] ||= []).push(to);
      return this;
    }
    compile({ checkpointer }) {
      return new CompiledGraph(this, checkpointer);
    }
  }

  class CompiledGraph {
    constructor(graph, saver) {
      this.graph = graph;
      this.saver = saver;
      this.disabledReducers = new Set(); // lets the UI switch a reducer off to show why it exists
    }

    _defaults() {
      const values = {};
      for (const [name, ch] of Object.entries(this.graph.channels)) values[name] = clone(ch.default);
      return values;
    }

    _checkpoint(threadId, step, source, values, next, extra = {}) {
      const id = this.saver.list(threadId).length;
      return this.saver.put(threadId, { id, step, source, values: clone(values), next: clone(next), ...extra });
    }

    /* Apply one super-step's writes through the reducers. Yields a 'write' event per channel. */
    *_apply(values, writes) {
      const byChannel = {};
      for (const w of writes) (byChannel[w.channel] ||= []).push(w);
      for (const [name, group] of Object.entries(byChannel)) {
        const ch = this.graph.channels[name];
        const reducer = this.disabledReducers.has(name) ? null : ch.reducer;
        if (!reducer && group.length > 1) {
          throw new InvalidUpdateError(
            `At key '${name}': Can receive only one value per step. Use an Annotated key to handle multiple values.`
          );
        }
        const before = values[name];
        values[name] = reducer ? group.reduce((acc, w) => reducer(acc, w.value), before) : group[0].value;
        yield {
          type: "write",
          channel: name,
          reducer: reducer ? ch.reducerName : "overwrite",
          from: group.map((w) => w.node),
          before: clone(before),
          after: clone(values[name]),
        };
      }
    }

    _route(node, goto) {
      const targets = goto == null ? this.graph.edges[node] || [END] : [].concat(goto);
      return targets.map((t) => (t instanceof Send ? { node: t.node, arg: t.arg, send: true } : { node: t, arg: null }));
    }

    /* Runs the graph for one input (or a resume Command) as a stream of events. */
    async *stream(input, { threadId }) {
      const last = this.saver.latest(threadId);
      let values = last ? clone(last.values) : this._defaults();
      let step = last ? last.step : -2;
      let tasks;
      let resume = null;

      if (input instanceof Command && input.resume !== undefined) {
        if (!last || !last.interrupt) throw new Error("Nothing to resume: the thread is not paused.");
        tasks = last.next;
        resume = { node: last.interrupt.node, value: input.resume };
        yield { type: "resume", value: input.resume, node: resume.node, checkpoint: last };
      } else {
        // the input becomes its own checkpoint, then __start__ writes it into the channels
        step += 1;
        const cpIn = this._checkpoint(threadId, step, "input", values, [{ node: START, arg: null }], { input: clone(input) });
        yield { type: "checkpoint", checkpoint: cpIn };
        const writes = Object.entries(input).map(([channel, value]) => ({ channel, value, node: START }));
        yield* this._apply(values, writes);
        step += 1;
        tasks = this._route(START, null);
        const cp = this._checkpoint(threadId, step, "loop", values, tasks);
        yield { type: "checkpoint", checkpoint: cp };
      }

      while (tasks.length) {
        yield { type: "superstep", step: step + 1, tasks: clone(tasks) };
        for (const t of tasks) {
          yield { type: "task_start", node: t.node, arg: t.arg, send: !!t.send, rerun: !!resume && resume.node === t.node };
        }

        const writes = [];
        const next = [];
        let interrupted = null;
        const view = clone(values); // every task in the step reads the same snapshot

        for (const t of tasks) {
          const logs = [];
          const ctx = {
            log: (text) => logs.push(text),
            interrupt: (value) => {
              if (resume && resume.node === t.node) {
                const answer = resume.value;
                resume = null; // consumed once
                logs.push({ resumed: answer });
                return answer;
              }
              throw new GraphInterrupt(value);
            },
          };
          let out;
          try {
            out = await this.graph.nodes[t.node](t.arg ?? view, ctx);
          } catch (err) {
            for (const text of logs) yield { type: "log", node: t.node, text };
            if (err instanceof GraphInterrupt) {
              interrupted = { node: t.node, value: err.value };
              continue;
            }
            throw err;
          }
          for (const text of logs) yield { type: "log", node: t.node, text };
          const update = out instanceof Command ? out.update : out;
          const goto = out instanceof Command ? out.goto : null;
          for (const [channel, value] of Object.entries(update || {})) writes.push({ channel, value, node: t.node });
          const routes = this._route(t.node, goto);
          next.push(...routes);
          yield { type: "task_end", node: t.node, update: clone(update || {}), command: out instanceof Command, routes: clone(routes) };
        }

        if (interrupted) {
          // no new checkpoint: the interrupt is stored on the current one (LangGraph keeps it as a pending write).
          // Nothing is applied; the paused node runs again from its first line on resume.
          const cp = this.saver.patchLatest(threadId, { interrupt: clone(interrupted) });
          yield { type: "interrupt", node: interrupted.node, value: interrupted.value, checkpoint: cp };
          return;
        }

        try {
          yield* this._apply(values, writes);
        } catch (err) {
          if (err instanceof InvalidUpdateError) {
            yield { type: "error", name: "InvalidUpdateError", message: err.message };
            return;
          }
          throw err;
        }

        // a plain node name scheduled twice runs once; each Send is its own task
        const seen = new Set();
        tasks = next.filter((t) => {
          if (t.node === END) return false;
          if (t.send) return true;
          if (seen.has(t.node)) return false;
          seen.add(t.node);
          return true;
        });
        step += 1;
        const cp = this._checkpoint(threadId, step, "loop", values, tasks);
        yield { type: "checkpoint", checkpoint: cp };
      }

      yield { type: "done", values: clone(values) };
    }
  }

  Object.assign(LG, { START, END, Command, Send, StateGraph, Saver, InvalidUpdateError, append });
})((window.LG = window.LG || {}));
