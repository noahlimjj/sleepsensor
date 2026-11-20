// Parses a PSG-Audio .rml annotation file: scored respiratory events, sleep
// stages and the reference AHI (apneas + hypopneas per hour of sleep).
import { readFileSync } from 'fs';

const RESP = ['ObstructiveApnea', 'CentralApnea', 'MixedApnea', 'Hypopnea'];

export function parseRml(path) {
  const xml = readFileSync(path, 'utf8');
  const durationSec = Number((xml.match(/<Session>[\s\S]*?<Duration>([\d.]+)<\/Duration>/) || [])[1] || 0);
  const events = [];
  const re = /<Event Family="(\w+)" Type="(\w+)" Start="([\d.]+)" Duration="([\d.]+)"/g;
  for (let m; (m = re.exec(xml)); ) {
    events.push({ family: m[1], type: m[2], start: Number(m[3]), dur: Number(m[4]) });
  }
  // staging appears twice (user + machine); the user-scored block comes first
  const block = (xml.match(/<UserStaging>[\s\S]*?<\/UserStaging>/) || xml.match(/<StagingData[\s\S]*?<\/StagingData>/) || [''])[0];
  const stages = [];
  const rs = /<Stage Type="(\w+)" Start="(\d+)"/g;
  for (let m; (m = rs.exec(block)); ) stages.push({ type: m[1], start: Number(m[2]) });
  let sleepSec = 0;
  for (let i = 0; i < stages.length; i++) {
    const end = i + 1 < stages.length ? stages[i + 1].start : durationSec;
    if (stages[i].type !== 'Wake' && stages[i].type !== 'NotScored') sleepSec += Math.max(0, end - stages[i].start);
  }
  const resp = events.filter((e) => RESP.includes(e.type));
  const count = (t) => resp.filter((e) => e.type === t).length;
  return {
    durationSec,
    sleepSec,
    events,
    stages,
    resp,
    counts: Object.fromEntries(RESP.map((t) => [t, count(t)])),
    ahi: sleepSec > 0 ? resp.length / (sleepSec / 3600) : 0,
    eventsPerRecHour: durationSec > 0 ? resp.length / (durationSec / 3600) : 0,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const f of process.argv.slice(2)) {
    const r = parseRml(f);
    console.log(
      [f.split('/').pop().replace('.rml', ''), (r.durationSec / 3600).toFixed(2), (r.sleepSec / 3600).toFixed(2), r.ahi.toFixed(1),
        r.eventsPerRecHour.toFixed(1), JSON.stringify(r.counts)].join('\t')
    );
  }
}
