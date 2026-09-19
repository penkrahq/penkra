// FILE: ReliablePointerSensor.ts
// Purpose: Completes interrupted pointer drags using standard browser lifecycle signals.

import { ActivationConstraint } from "@dnd-kit/abstract";
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

interface ElementBoundaryConstraintOptions {
  readonly element: Element;
}

/**
 * Keeps a primary mouse press a click until the pointer leaves the exact
 * control it pressed. This lets clickable tabs and rows double as sortable
 * handles without turning ordinary hand jitter into a drag preview.
 */
class ElementBoundaryConstraint extends ActivationConstraint<
  PointerEvent,
  ElementBoundaryConstraintOptions
> {
  private bounds: DOMRect | undefined;

  override onEvent(event: PointerEvent): void {
    switch (event.type) {
      case "pointerdown":
        this.bounds = this.options.element.getBoundingClientRect();
        break;
      case "pointermove": {
        const bounds = this.bounds;
        if (!bounds) return;
        if (
          event.clientX < bounds.left ||
          event.clientX > bounds.right ||
          event.clientY < bounds.top ||
          event.clientY > bounds.bottom
        ) {
          this.activate(event);
        }
        break;
      }
      case "pointercancel":
      case "pointerup":
        this.abort();
        break;
    }
  }

  override abort(): void {
    this.bounds = undefined;
  }
}

class ReliablePointerSensorImplementation extends PointerSensor {
  private terminalListeners: AbortController | undefined;

  protected override activationConstraints(
    event: PointerEvent,
    source: Draggable,
  ): PointerActivationConstraintSet {
    if (event.pointerType === "touch") {
      return [new PointerActivationConstraints.Delay({ value: 250, tolerance: 5 })];
    }
    if (event.pointerType === "mouse") {
      const element = source.handle ?? source.element;
      if (element) {
        return [new ElementBoundaryConstraint({ element })];
      }
    }
    return [new PointerActivationConstraints.Distance({ value: 5 })];
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
