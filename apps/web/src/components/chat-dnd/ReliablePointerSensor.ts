// FILE: ReliablePointerSensor.ts
// Purpose: Completes interrupted pointer drags using standard browser lifecycle signals.

import {
  PointerActivationConstraints,
  PointerSensor,
  type Draggable,
  type PointerSensorOptions,
} from "@dnd-kit/dom";

type PointerActivationConstraintSet = Exclude<
  NonNullable<PointerSensorOptions["activationConstraints"]>,
  (...args: never[]) => unknown
>;

class ReliablePointerSensorImplementation extends PointerSensor {
  private terminalListeners: AbortController | undefined;

  protected override activationConstraints(event: PointerEvent): PointerActivationConstraintSet {
    return event.pointerType === "touch"
      ? [new PointerActivationConstraints.Delay({ value: 250, tolerance: 5 })]
      : [new PointerActivationConstraints.Distance({ value: 5 })];
  }

  protected override handleStart(source: Draggable, event: PointerEvent) {
    this.terminalListeners?.abort();
    super.handleStart(source, event);
    if (!this.manager.dragOperation.status.initialized) return;

    const document = source.element?.ownerDocument;
    const window = document?.defaultView;
    if (!document || !window) return;

    const controller = new AbortController();
    const { signal } = controller;
    const pointerId = event.pointerId;
    const cancel = (terminalEvent: Event) => this.handleCancel(terminalEvent);
    const finishReleasedPointer = (terminalEvent: Event) => {
      const { status } = this.manager.dragOperation;
      if (!status.idle) {
        this.manager.actions.stop({ event: terminalEvent, canceled: !status.initialized });
      }
      this.cleanup();
    };

    document.addEventListener(
      "lostpointercapture",
      (terminalEvent) => {
        if (terminalEvent.pointerId === pointerId && terminalEvent.target === document.body) {
          finishReleasedPointer(terminalEvent);
        }
      },
      { capture: true, signal },
    );
    window.addEventListener(
      "pointermove",
      (moveEvent) => {
        if (
          moveEvent.pointerId === pointerId &&
          moveEvent.pointerType === "mouse" &&
          moveEvent.buttons === 0
        ) {
          finishReleasedPointer(moveEvent);
        }
      },
      { capture: true, signal },
    );
    window.addEventListener("blur", cancel, { signal });
    window.addEventListener("pagehide", cancel, { signal });
    document.addEventListener(
      "visibilitychange",
      (visibilityEvent) => {
        if (document.visibilityState === "hidden") cancel(visibilityEvent);
      },
      { signal },
    );
    this.terminalListeners = controller;
  }

  protected override cleanup() {
    this.terminalListeners?.abort();
    this.terminalListeners = undefined;
    super.cleanup();
  }
}

export const ReliablePointerSensor: typeof PointerSensor = ReliablePointerSensorImplementation;
