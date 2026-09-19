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

interface SemanticDropTargetConstraintOptions {
  readonly sourceElement: Element;
}

/**
 * Keeps a primary mouse press a click until it reaches another actual drop
 * target. Leaving the source by a pixel is not drag intent; crossing into a
 * sibling row/tab or another drop zone is.
 */
class SemanticDropTargetConstraint extends ActivationConstraint<
  PointerEvent,
  SemanticDropTargetConstraintOptions
> {
  private armed = false;

  override onEvent(event: PointerEvent): void {
    switch (event.type) {
      case "pointerdown":
        this.armed = true;
        break;
      case "pointermove": {
        if (!this.armed) return;
        const { sourceElement } = this.options;
        const targets = sourceElement.ownerDocument.querySelectorAll<HTMLElement>(
          "[data-shell-dnd-activation-target='true']",
        );
        for (const target of targets) {
          if (
            target === sourceElement ||
            sourceElement.contains(target) ||
            target.contains(sourceElement)
          ) {
            continue;
          }
          const bounds = target.getBoundingClientRect();
          if (
            event.clientX >= bounds.left &&
            event.clientX <= bounds.right &&
            event.clientY >= bounds.top &&
            event.clientY <= bounds.bottom
          ) {
            this.activate(event);
            break;
          }
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
    this.armed = false;
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
      if (source.element) {
        return [new SemanticDropTargetConstraint({ sourceElement: source.element })];
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
