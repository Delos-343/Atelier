'use client';

import { useState } from 'react';
import { useOffline } from './offline/OfflineProvider';

export function RecordQcForm({ lotId, onDone }: { lotId: string; onDone?: () => void }) {
  const { submit } = useOffline();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function record(status: 'passed' | 'failed') {
    setBusy(true);
    setNote(null);
    const res = await submit('/api/qc', { lotId, status });
    setBusy(false);
    if (res.ok) onDone?.();
    else if (res.queued) setNote('queued');
    else setNote(res.error ?? 'failed');
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <button className="btn btn-sm btn-ok" disabled={busy} onClick={() => record('passed')}>
        Pass
      </button>
      <button className="btn btn-sm btn-bad" disabled={busy} onClick={() => record('failed')}>
        Reject
      </button>
      {note && <span className="text-[0.85rem] text-bad">{note}</span>}
    </span>
  );
}
