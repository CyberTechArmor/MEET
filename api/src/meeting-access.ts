// Pure authorization rules, shared by handlers and regression tests.
export function permitsApiOperation(permissions: readonly string[], operation: 'read' | 'write' | 'admin'): boolean {
  return permissions.includes('admin') || permissions.includes(operation);
}

export function isHostForMeeting(
  claims: { sub?: string; video?: { room?: string; roomJoin?: boolean; roomAdmin?: boolean } },
  roomName: string,
  participantIdentity: string,
): boolean {
  return claims.sub === participantIdentity
    && claims.video?.room === roomName
    && claims.video?.roomJoin === true
    && claims.video?.roomAdmin === true;
}
