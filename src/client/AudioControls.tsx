import type { useExperimentAudio } from './useExperimentAudio';
import './audio.css';

export function AudioControls({ audio }: { audio: ReturnType<typeof useExperimentAudio> }) {
  return <div className="audio-rack" aria-label="Sound and voice controls">
    <button className={`audio-switch ${audio.enabled ? 'is-active' : ''}`} onClick={audio.toggle} aria-pressed={audio.enabled} title={audio.enabled ? 'Mute all sounds and speech' : 'Enable chamber sounds and character voices'}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M4 9h4l5-4v14l-5-4H4V9Z" />{audio.enabled ? <><path d="M16 8a6 6 0 0 1 0 8M19 5a10 10 0 0 1 0 14" /></> : <path d="m17 9 5 6m0-6-5 6" />}</svg>
      <span>{audio.enabled ? 'Mute sound' : 'Enable sound'}</span>
    </button>
    {audio.enabled && <>
      <button className={`audio-voices ${audio.voicesEnabled ? 'is-active' : ''}`} onClick={audio.toggleVoices} aria-pressed={audio.voicesEnabled}>{audio.voicesEnabled ? 'Voices on' : 'Voices off'}</button>
      <label className="audio-volume"><span>Volume</span><input aria-label="Sound volume" type="range" min="0" max="100" step="5" value={Math.round(audio.volume * 100)} onChange={event => audio.setVolume(Number(event.target.value) / 100)} /></label>
      {!audio.voiceAvailable && audio.voicesEnabled && <span className="audio-unavailable" role="status">Device voices unavailable · read the subtitles</span>}
    </>}
  </div>;
}
