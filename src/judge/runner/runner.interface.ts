export interface ExecutionRequest {
  language: string;
  sourceCode: string;
  input: string;
  timeLimitMs: number;
  memoryLimitMb: number;
  outputLimitBytes?: number;
  simulateRunnerCrash?: boolean;
  simulateHang?: boolean;
}

export interface ExecutionResult {
  exitCode: number;
  isCompilationError?: boolean;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  executionTimeMs: number;
  memoryUsageMb: number;
  outputTruncated: boolean;
  executionMode: 'docker' | 'subprocess';
  isInfrastructureError?: boolean;
}

export interface ICodeRunner {
  readonly mode: 'docker' | 'subprocess';
  execute(request: ExecutionRequest): Promise<ExecutionResult>;
}
