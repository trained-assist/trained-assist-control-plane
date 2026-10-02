import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';

export interface Env {
  DB: D1Database;
  TASK_WORKFLOW: Workflow;
}

export interface TaskWorkflowParams {
  taskId: string;
}

export class TaskWorkflow extends WorkflowEntrypoint<Env, TaskWorkflowParams> {
  override async run(event: WorkflowEvent<TaskWorkflowParams>, step: WorkflowStep): Promise<unknown> {
    return step.do('echo', async () => ({ taskId: event.payload.taskId }));
  }
}

export default {
  async fetch(_req: Request, _env: Env): Promise<Response> {
    return new Response('trained-assist-control-plane', {
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  },
};
