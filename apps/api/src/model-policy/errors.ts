export class ModelPolicyConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelPolicyConflictError";
  }
}

export class ModelPolicyUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelPolicyUnavailableError";
  }
}

export class ModelPolicyRevisionNotFoundError extends Error {
  constructor() {
    super("Workspace model-policy revision was not found");
    this.name = "ModelPolicyRevisionNotFoundError";
  }
}

export class ModelPolicyNotFoundError extends Error {
  constructor() {
    super("Owned conversation was not found");
    this.name = "ModelPolicyNotFoundError";
  }
}

export class CatalogRefreshActiveError extends Error {
  constructor() {
    super("A catalog refresh already owns at least one requested model");
    this.name = "CatalogRefreshActiveError";
  }
}

export class ModelPolicyChangedError extends Error {
  constructor() {
    super("Workspace model policy changed after it was read");
    this.name = "ModelPolicyChangedError";
  }
}
