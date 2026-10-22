import { useEffect, useRef, type RefObject } from "react";
import { createPet } from "@watchling/renderer/pet/pet-figure.ts";
import {
  stateLabels,
  type SemanticState,
} from "@watchling/shared/ui-contract.ts";
import { useDraggable } from "@/components/window/useDraggable.ts";
import styles from "./Peep.module.css";

type Pet = ReturnType<typeof createPet>;

export function Peep({
  state,
  companions,
  elementRef,
  boundsRef,
  movable,
  onToggle,
}: {
  state: SemanticState;
  companions: number;
  elementRef: RefObject<HTMLButtonElement | null>;
  boundsRef: RefObject<HTMLElement | null>;
  movable: boolean;
  onToggle: () => void;
}) {
  const backRef = useRef<HTMLCanvasElement>(null);
  const bodyRef = useRef<HTMLCanvasElement>(null);
  const frontRef = useRef<HTMLCanvasElement>(null);
  const petRef = useRef<Pet | null>(null);

  useEffect(() => {
    const pet = createPet(bodyRef.current!, {
      back: backRef.current!,
      front: frontRef.current!,
    });
    petRef.current = pet;
    return () => {
      pet.destroy();
      petRef.current = null;
    };
  }, []);
  useEffect(() => petRef.current?.setState(state), [state]);
  useEffect(() => petRef.current?.setCompanions(companions), [companions]);

  const onBody = (event: { clientX: number; clientY: number }) => {
    const pet = petRef.current;
    const body = bodyRef.current;
    if (!pet || !body) return false;
    const box = body.getBoundingClientRect();
    return pet.hitTest(event.clientX - box.left, event.clientY - box.top);
  };

  useDraggable(elementRef, elementRef, boundsRef, {
    enabled: movable,
    canStart: onBody,
    onClick: onToggle,
  });

  return (
    <div className={styles.stage}>
      <button
        ref={elementRef}
        type="button"
        className={styles.peep}
        aria-label={`Peep, ${stateLabels[state]}. Show sessions`}
        onClick={(event) => {
          if (!movable || event.detail === 0) onToggle();
        }}
        onPointerMove={(event) => {
          if (movable)
            event.currentTarget.toggleAttribute("data-hit", onBody(event));
        }}
      >
        <canvas ref={backRef} />
        <canvas ref={bodyRef} />
        <canvas ref={frontRef} />
      </button>
    </div>
  );
}
