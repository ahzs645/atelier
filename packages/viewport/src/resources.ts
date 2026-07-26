interface Disposable {
  dispose(): void;
}

/** Owns a collection of disposable GPU resources. */
export class ResourceScope {
  private readonly resources = new Set<Disposable>();

  track<T extends Disposable>(resource: T): T {
    this.resources.add(resource);
    return resource;
  }

  release(): void {
    const resources = [...this.resources];
    this.resources.clear();
    let firstError: unknown;
    for (const resource of resources) {
      try {
        resource.dispose();
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError !== undefined) throw firstError;
  }
}
