import type {LocalTrack,Room} from 'livekit-client';
/** Own captures before publication finishes; Room.disconnect only sees published tracks. */
export function ownPrivateMedia(room:Room){
 let stopped=false;const tracks=new Set<LocalTrack>(),participant=room.localParticipant;
 const capture=participant.createTracks.bind(participant),screen=participant.createScreenTracks.bind(participant);
 const retain=(created:LocalTrack[])=>{for(const track of created){if(stopped)track.stop();else tracks.add(track);}if(stopped)throw Error('Private call closed.');return created;};
 participant.createTracks=async options=>retain(await capture(options));
 participant.createScreenTracks=async options=>retain(await screen(options));
 return ()=>{stopped=true;for(const track of tracks)track.stop();tracks.clear();};
}
