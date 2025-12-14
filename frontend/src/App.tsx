import { useRoomStore } from './stores/roomStore';
import JoinForm from './components/JoinForm';
import VideoRoom from './components/VideoRoom';

function App() {
  const view = useRoomStore((state) => state.view);

  return (
    <div className="h-full w-full bg-meet-bg">
      {view === 'join' ? <JoinForm /> : <VideoRoom />}
    </div>
  );
}

export default App;
