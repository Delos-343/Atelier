'use client';

export function OfflineBanner({
  online,
  pendingCount,
  onSync,
}: {
  online: boolean;
  pendingCount: number;
  onSync: () => void;
}) {
  if (online && pendingCount === 0) return null;

  return (
    <div className={`offbar ${online ? 'offbar-pending' : 'offbar-offline'}`} role="status">
      <span className="offbar-dot" aria-hidden="true" />
      <span className="flex-1">
        {online
          ? `${pendingCount} change${pendingCount === 1 ? '' : 's'} waiting to sync`
          : pendingCount > 0
            ? `Offline — ${pendingCount} change${pendingCount === 1 ? '' : 's'} queued`
            : 'Offline — showing last synced data'}
      </span>
      {online && pendingCount > 0 && (
        <button className="offbar-btn" onClick={onSync}>
          Sync now
        </button>
      )}
    </div>
  );
}
