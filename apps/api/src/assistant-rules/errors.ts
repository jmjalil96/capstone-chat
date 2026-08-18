export class AssistantRulesChangedError extends Error {
  constructor() {
    super("Workspace assistant rules changed");
    this.name = "AssistantRulesChangedError";
  }
}

export class AssistantRulesConflictError extends Error {
  constructor(message = "Workspace assistant rules conflict") {
    super(message);
    this.name = "AssistantRulesConflictError";
  }
}

export class AssistantRulesNotFoundError extends Error {
  constructor() {
    super("Workspace assistant rules revision was not found");
    this.name = "AssistantRulesNotFoundError";
  }
}
