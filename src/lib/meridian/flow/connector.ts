/** Standardized Flow Connectors and Pipeline Runner (n8n-style modular architecture). */

export type FlowNodeType =
  | "trigger"
  | "source"
  | "decode"
  | "grade"
  | "plan"
  | "produce"
  | "gate"
  | "publish"
  | "sync";

export type FlowContext = {
  organizationId: string;
  brandId: string;
  correlationId: string;
  dryRun?: boolean;
  env?: NodeJS.ProcessEnv;
  state?: Record<string, unknown>;
};

export type NodeExecutionResult<T = unknown> = {
  ok: boolean;
  data: T;
  error?: string;
  logs?: string[];
  timingMs?: number;
};

export interface FlowNode<TIn = any, TOut = any> {
  id: string;
  name: string;
  type: FlowNodeType;
  execute(input: TIn, context: FlowContext): Promise<NodeExecutionResult<TOut>>;
}

export type StepReport = {
  nodeId: string;
  nodeName: string;
  nodeType: FlowNodeType;
  ok: boolean;
  timingMs: number;
  output: unknown;
  error?: string;
  logs: string[];
};

export type FlowExecutionReport = {
  flowName: string;
  ok: boolean;
  totalDurationMs: number;
  steps: StepReport[];
  finalOutput?: unknown;
  error?: string;
};

export class FlowPipeline {
  private nodes: FlowNode[] = [];
  public readonly name: string;

  constructor(name: string) {
    this.name = name;
  }

  /** Fluent pipe connection: chains the output of the current node to the input of the next. */
  pipe<TIn, TOut>(node: FlowNode<TIn, TOut>): this {
    this.nodes.push(node as FlowNode);
    return this;
  }

  getNodes(): readonly FlowNode[] {
    return this.nodes;
  }

  async run(initialInput: unknown, context: FlowContext): Promise<FlowExecutionReport> {
    const startTime = Date.now();
    const steps: StepReport[] = [];
    let currentData = initialInput;
    let flowOk = true;
    let flowError: string | undefined;

    for (const node of this.nodes) {
      const stepStart = Date.now();
      try {
        const result = await node.execute(currentData, context);
        const stepDuration = Date.now() - stepStart;
        steps.push({
          nodeId: node.id,
          nodeName: node.name,
          nodeType: node.type,
          ok: result.ok,
          timingMs: stepDuration,
          output: result.data,
          error: result.error,
          logs: result.logs ?? [],
        });

        if (!result.ok) {
          flowOk = false;
          flowError = result.error || `Node "${node.name}" (${node.id}) failed execution.`;
          break;
        }

        currentData = result.data;
      } catch (err) {
        const stepDuration = Date.now() - stepStart;
        const msg = err instanceof Error ? err.message : String(err);
        steps.push({
          nodeId: node.id,
          nodeName: node.name,
          nodeType: node.type,
          ok: false,
          timingMs: stepDuration,
          output: null,
          error: msg,
          logs: [`Unhandled exception in node ${node.id}: ${msg}`],
        });
        flowOk = false;
        flowError = msg;
        break;
      }
    }

    return {
      flowName: this.name,
      ok: flowOk,
      totalDurationMs: Date.now() - startTime,
      steps,
      finalOutput: flowOk ? currentData : undefined,
      error: flowError,
    };
  }
}

export function createFlow(name: string): FlowPipeline {
  return new FlowPipeline(name);
}
