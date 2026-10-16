import {afterEach,describe,expect,it,vi} from 'vitest';
import {DisconnectReason} from 'livekit-client';
import {privateRecovery} from './nodusPrivateRecovery';
afterEach(()=>vi.useRealTimers());
describe('private SDK disconnect recovery',()=>{
 for(const reason of [DisconnectReason.ROOM_CLOSED,DisconnectReason.ROOM_DELETED,DisconnectReason.PARTICIPANT_REMOVED,DisconnectReason.DUPLICATE_IDENTITY])it(`terminal reason ${reason} cancels even an already pending network retry`,async()=>{
  vi.useFakeTimers();const retry=vi.fn(async()=>{}),left=vi.fn(),teardown=vi.fn(),controller=privateRecovery({retry,left,teardown,reconnecting:vi.fn(),failed:vi.fn()});
  // Exact SDK ordering: state becomes disconnected, then separate reason arrives.
  controller.disconnected(DisconnectReason.UNKNOWN_REASON);controller.disconnected(reason);await vi.runAllTimersAsync();controller.retry();
  expect(retry).not.toHaveBeenCalled();expect(left).toHaveBeenCalledTimes(1);expect(teardown).toHaveBeenCalledTimes(1);
 });
 it('network disconnect retries and a connected event clears the pending retry',async()=>{vi.useFakeTimers();const retry=vi.fn(async()=>{}),reconnecting=vi.fn(),c=privateRecovery({retry,left:vi.fn(),teardown:vi.fn(),reconnecting,failed:vi.fn()});c.disconnected(DisconnectReason.UNKNOWN_REASON);await vi.advanceTimersByTimeAsync(1500);expect(retry).toHaveBeenCalledOnce();c.disconnected(DisconnectReason.UNKNOWN_REASON);c.connected();await vi.runAllTimersAsync();expect(retry).toHaveBeenCalledOnce();});
});
