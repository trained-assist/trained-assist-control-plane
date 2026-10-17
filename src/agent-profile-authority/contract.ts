/** Versioned context port owned by the Agent profile authority. */
export type AgentProfileContext = { principalId: string; profileId: string; sessionId: string;
  profileGeneration: number };
export type AgentProfileAuthority = {
  resolveBrowserSession(request: Request): Promise<AgentProfileContext | null>;
  resolveCurrentSession(sessionId: string): Promise<AgentProfileContext | null>;
};
