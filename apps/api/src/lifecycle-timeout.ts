export function settleWithin(operation: Promise<unknown>, milliseconds: number): Promise<boolean> {
  return new Promise((resolve) => {
    let finished = false;
    const finish = (settled: boolean): void => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timer);
      resolve(settled);
    };
    const timer = setTimeout(() => finish(false), milliseconds);
    void operation.then(
      () => finish(true),
      () => finish(true),
    );
  });
}
