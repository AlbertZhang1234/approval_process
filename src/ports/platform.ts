export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  nextId(
    scope:
      | "instance"
      | "execution"
      | "task"
      | "transition"
      | "event"
      | "workflow-definition"
      | "workflow-version",
  ): string;
}

export const systemClock: Clock = {
  now: () => new Date(),
};
