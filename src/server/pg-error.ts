/**
 * Shared Postgres / PostgREST error → HTTP mapping for the admin RPC layer.
 *
 * It standardizes the *status-code contract* every admin RPC should honor —
 *
 *   42501  (insufficient_privilege)        → 403
 *   P0002  (our raised "not found")        → 404
 *   P0001  (our raised business rules)     → 409, raised message passed through
 *   anything else                          → 500
 *
 * — while leaving the user-facing wording to each caller, because the messages
 * are deliberately domain-specific ("Admin clearance required." for user admin
 * vs. "You don't have permission…" for formulas). Callers that have
 * endpoint-specific codes (e.g. a 23514 check violation) handle those first, then
 * delegate here for the common cases.
 */
export interface PgLikeError {
  code?: string;
  message?: string;
}

export interface HttpError {
  error: string;
  status: number;
}

/**
 * The standard server-action result: a success carrying data, or a failure
 * carrying an HTTP-mappable error. Domain modules alias this (UserResult,
 * AccountResult, FxResult, CrudResult) so route handlers share one shape.
 */
export type ServerResult<T> = { ok: true; data: T } | ({ ok: false } & HttpError);

export interface RpcErrorMessages {
  /** 500 fallback, used when the error carries no message of its own. */
  fallback: string;
  /** 42501 message. Defaults to a generic admin-clearance line. */
  forbidden?: string;
  /** P0002 message. When omitted, the error's own message is passed through. */
  notFound?: string;
  /** P0001 fallback, used only if a raised exception somehow carries no message. */
  notAllowed?: string;
}

export function mapRpcError(error: PgLikeError | null, opts: RpcErrorMessages): HttpError {
  switch (error?.code) {
    case '42501':
      return { error: opts.forbidden ?? 'Admin clearance required.', status: 403 };
    case 'P0002':
      return { error: opts.notFound ?? error?.message ?? 'Not found.', status: 404 };
    case 'P0001':
      return { error: error?.message ?? opts.notAllowed ?? 'Operation not allowed.', status: 409 };
    default:
      return { error: error?.message ?? opts.fallback, status: 500 };
  }
}
