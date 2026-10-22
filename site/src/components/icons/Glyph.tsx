function peepPath(): string {
  const points = Array.from({ length: 144 }, (_, index) => {
    const angle = (index / 144) * Math.PI * 2;
    const radius =
      7.1 *
      (1 +
        0.042 * Math.cos(9 * angle + 0.2) +
        0.017 * Math.cos(7 * angle + 0.6));
    return `${(9 + radius * Math.cos(angle)).toFixed(2)} ${(9.4 + radius * Math.sin(angle)).toFixed(2)}`;
  });
  const eyes = [6.4, 11.6]
    .map((x) => `M${x - 1.15} 9.4a1.15 1.6 0 1 0 2.3 0a1.15 1.6 0 1 0 -2.3 0Z`)
    .join("");
  return `M${points.join("L")}Z${eyes}`;
}

const glyphs = {
  peep: { viewBox: "0 0 18 18", d: peepPath() },
  blob: {
    viewBox: "0 0 18 18",
    d: "M9 2.2c1.5 0 2.4.9 2.4.9s-.4-1.3 1-2c.3 1.2-.6 2.1-.6 2.1 2.5.6 3.7 2.9 3.7 5.6 0 3.6-2.4 7-4.4 7-1 0-1.3-.5-2.1-.5s-1.1.5-2.1.5c-2 0-4.4-3.4-4.4-7 0-3.3 1.9-5.7 4.6-5.7.9 0 1.4.3 1.9.3Z",
  },
  terminal: {
    viewBox: "0 0 20 20",
    d: "M3 3h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm2.2 4 3 3-3 3-.9-.9 2.1-2.1-2.1-2.1.9-.9ZM9.5 12.4h4.6v1.2H9.5v-1.2Z",
  },
  github: {
    viewBox: "0 0 16 16",
    d: "M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z",
  },
};

export function Glyph({
  name,
  className,
}: {
  name: keyof typeof glyphs;
  className?: string | undefined;
}) {
  const { viewBox, d } = glyphs[name];
  return (
    <svg viewBox={viewBox} className={className} aria-hidden="true">
      <path d={d} fillRule="evenodd" />
    </svg>
  );
}
