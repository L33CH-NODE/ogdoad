// Ogdoad's geometry: the octagram (the Eighth: two squares, one turned by 45 degrees) inside
// concentric orbits. Used sparingly, as a mark and as a slow, quiet presence behind key moments.

export function Octagram({ size = 28, spin = false, className = "" }: { size?: number; spin?: boolean; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" fill="none" aria-hidden="true" className={`${spin ? "geo-spin" : ""} ${className}`.trim()}>
      <circle cx="50" cy="50" r="46" stroke="currentColor" strokeOpacity="0.35" strokeWidth="1.5" />
      <rect x="20" y="20" width="60" height="60" stroke="currentColor" strokeWidth="3" strokeLinejoin="round" />
      <rect x="20" y="20" width="60" height="60" stroke="currentColor" strokeWidth="3" strokeLinejoin="round" transform="rotate(45 50 50)" />
      <circle cx="50" cy="50" r="7" fill="currentColor" />
    </svg>
  );
}

/** A large, faint octagram with orbits, slowly turning behind a moment (onboarding, the lock). */
export function Halo() {
  return (
    <svg className="halo" viewBox="0 0 400 400" fill="none" aria-hidden="true">
      <circle cx="200" cy="200" r="190" stroke="currentColor" strokeOpacity="0.08" />
      <circle cx="200" cy="200" r="150" stroke="currentColor" strokeOpacity="0.07" strokeDasharray="2 10" />
      <circle cx="200" cy="200" r="104" stroke="currentColor" strokeOpacity="0.08" />
      <g className="geo-spin-slow">
        <rect x="95" y="95" width="210" height="210" stroke="currentColor" strokeOpacity="0.07" />
        <rect x="95" y="95" width="210" height="210" stroke="currentColor" strokeOpacity="0.07" transform="rotate(45 200 200)" />
      </g>
      {Array.from({ length: 8 }, (_, i) => {
        const a = (i * Math.PI) / 4;
        return <circle key={i} cx={200 + 150 * Math.cos(a)} cy={200 + 150 * Math.sin(a)} r="3" fill="currentColor" fillOpacity="0.18" />;
      })}
    </svg>
  );
}
