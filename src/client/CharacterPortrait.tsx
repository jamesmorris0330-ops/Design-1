import { useId } from 'react';

export interface CharacterPortraitProps {
  seed: string;
  speaking?: boolean;
  mood?: 'calm' | 'tense' | 'critical';
  className?: string;
}

function seedNumber(seed: string): number {
  let value = 2166136261;
  for (const character of seed) value = Math.imul(value ^ character.charCodeAt(0), 16777619);
  return value >>> 0;
}

/** An illustrated, animated Subject. Its appearance is generated from its seat ID. */
export function CharacterPortrait({ seed, speaking = false, mood = 'calm', className = '' }: CharacterPortraitProps) {
  const id = useId().replaceAll(':', '');
  const value = seedNumber(seed);
  const variant = value % 6;
  const skin = ['#d99b78', '#a3654e', '#edbb94', '#694238', '#c88663', '#8e5949'][variant];
  const shade = ['#9f6553', '#693c37', '#b17961', '#422b2b', '#905540', '#573a35'][variant];
  const hair = ['#26212b', '#171d27', '#63544b', '#171821', '#b77746', '#29303a'][variant];
  const accent = ['#55d3d8', '#debd77', '#82b6e9', '#e5917b', '#baa6e8', '#7fc4a0'][variant];
  const longHair = variant === 0 || variant === 4;
  const beard = variant === 1 || variant === 5;
  const glasses = variant === 2;
  const brow = mood === 'calm' ? 66 : 64;
  return <svg viewBox="0 0 120 156" className={`character-portrait ${speaking ? 'character-speaking' : ''} character-${mood} ${className}`} aria-hidden="true" focusable="false">
    <defs>
      <linearGradient id={`${id}-body`} x1="0" y1="0" x2="1" y2="1"><stop stopColor="#3a5369" /><stop offset="1" stopColor="#111e30" /></linearGradient>
      <linearGradient id={`${id}-skin`} x1="0" y1="0" x2="1" y2=".5"><stop stopColor={skin} /><stop offset="1" stopColor={shade} /></linearGradient>
      <radialGradient id={`${id}-aura`}><stop stopColor={accent} stopOpacity=".24" /><stop offset="1" stopColor={accent} stopOpacity="0" /></radialGradient>
    </defs>
    <ellipse cx="60" cy="90" rx="58" ry="65" fill={`url(#${id}-aura)`} />
    <g className="portrait-breath">
      {longHair && <path d="M30 47Q28 17 58 15Q88 13 91 47L98 119 23 119Z" fill={hair} />}
      <path d="M43 106 27 112Q8 120 7 156H113Q112 121 94 112L76 106Z" fill={`url(#${id}-body)`} />
      <path d="M45 94 43 114Q58 126 76 113L75 94Z" fill={shade} />
      <path d="M47 97V111Q59 117 71 110V97Z" fill={skin} opacity=".6" />
      <path d="M43 109 31 113 38 156H48L48 121Z M76 109 88 113 82 156H71L72 121Z" fill="#122538" stroke="#597080" strokeWidth="1" />
      <path d="M49 121 60 131 72 121 66 156H53Z" fill="#152232" />
      <path d="M10 147H34 M86 147H111" stroke={accent} strokeWidth="3" opacity=".65" />
      <rect x="83" y="128" width="13" height="7" rx="1" fill="#122638" stroke={accent} strokeWidth=".8" />
      <path d="M86 131H93" stroke={accent} strokeWidth="1" />
      <ellipse cx="33" cy="71" rx="6" ry="10" fill={shade} /><ellipse cx="86" cy="71" rx="6" ry="10" fill={shade} />
      <path d="M34 47Q36 24 59 24Q83 24 85 47L83 81Q80 105 60 112Q38 104 35 83Z" fill={`url(#${id}-skin)`} />
      <path d="M58 35Q43 41 42 65L44 89Q48 102 60 107" stroke={skin} strokeWidth="7" opacity=".2" fill="none" />
      {variant === 3 ? <>
        <path d="M30 57Q23 18 56 17Q94 12 90 59L80 49Q74 36 61 35Q43 34 34 59Z" fill={hair} />
        {[0, 1, 2, 3, 4, 5].map(number => <circle key={number} cx={33 + number * 10} cy={29 - Math.sin(number) * 4} r="11" fill={hair} />)}
      </> : variant === 5 ? <path d="M35 46Q39 24 62 25Q80 25 85 47L81 43Q77 28 59 30Q41 30 35 46Z" fill={hair} /> :
        <path d={longHair ? 'M31 58Q27 16 60 17Q92 17 88 63L77 48 66 32Q51 51 35 51Z' : 'M32 59 31 39Q35 17 65 21L85 29 90 61 80 46Q59 39 43 49Z'} fill={hair} />}
      <path d={`M42 ${brow + 1}Q49 ${brow - 3} 55 ${brow} M65 ${brow}Q73 ${brow - 3} 79 ${brow + 1}`} stroke={hair} strokeWidth="2.8" strokeLinecap="round" fill="none" />
      <g className="portrait-eyes">
        <path d="M42 71Q49 66 55 71Q49 76 42 71 M65 71Q72 66 79 71Q72 76 65 71" fill="#f0dac4" />
        <ellipse cx="49" cy="71" rx="2.4" ry="3" fill="#263b47" /><ellipse cx="72" cy="71" rx="2.4" ry="3" fill="#263b47" />
        <circle cx="49.6" cy="70.2" r=".7" fill="#f2e5d8" /><circle cx="72.6" cy="70.2" r=".7" fill="#f2e5d8" />
      </g>
      <path d="M60 71 56 84Q60 88 65 83" stroke={shade} strokeWidth="1.4" fill="none" />
      <path d="M41 85 48 87M73 87 80 85" stroke={shade} strokeWidth="1" opacity=".5" />
      {beard && <path d="M36 80Q42 85 46 88L54 92 65 92 75 88Q81 86 84 80L79 99Q59 116 41 99Z" fill={hair} opacity=".65" />}
      <g className="portrait-mouth"><ellipse cx="60" cy="94" rx="7" ry={speaking ? 4 : 1.4} fill="#512e34" /><path d="M55 93H65" stroke={speaking ? '#e7d7cb' : shade} strokeWidth={speaking ? 1.8 : .8} /></g>
      {glasses && <g fill="none" stroke="#283343" strokeWidth="1.9"><rect x="39" y="65" width="18" height="14" rx="5" /><rect x="63" y="65" width="18" height="14" rx="5" /><path d="M57 70H63 M34 68H39 M81 68H86" /></g>}
      <path d="M88 64 92 69 89 86" stroke={accent} strokeWidth="2" fill="none" /><circle cx="89" cy="88" r="2" fill={accent} />
      <path d="M38 113 33 143 M85 113 89 142" stroke="#7794a5" strokeWidth=".8" opacity=".6" />
    </g>
    <path d="M4 23V8H20 M100 8H116V23 M4 133V148H20 M100 148H116V133" stroke={accent} strokeWidth=".8" opacity=".45" fill="none" />
    <path d="M8 155H112" stroke={accent} opacity=".7" />
  </svg>;
}
