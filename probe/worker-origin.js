// The probe Worker's origin, e.g. "https://vprok-voice-probe.<account>.workers.dev".
// Written on the Mac after the first `deploy.sh` (spikes/voice-probe/README.md). Not a
// secret. Deliberately not taken from the URL: a link carrying another origin would make
// the page send the user's ID token there.
export const WORKER_ORIGIN = 'https://vprok-voice-probe.kufar-watchbot.workers.dev';
