export type DeferredSessionTranscriptReadOperations = {
  "deferredSessionImport.verifyMissingTranscript": {
    input: {
      agentId: string;
      sessionId: string;
      identity: { size: number; sha256: string };
    };
    output: boolean;
  };
};
