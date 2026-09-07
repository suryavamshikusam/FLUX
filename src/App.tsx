import { useEffect, useState, useRef } from 'react';
import type { DragEvent } from 'react';
import { io, Socket } from 'socket.io-client';
import { FileUp, Laptop, Smartphone, Monitor } from 'lucide-react';
import { startStreamSender } from './utils/streamSender';
import { StreamReceiver } from './utils/streamReceiver';
import type { FileMeta } from './utils/streamReceiver';
import { generateRandomName, getDeviceType } from './utils/nameGenerator';

const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || `http://${window.location.hostname}:3001`;

type TransferState = {
  isTransferring: boolean;
  progress: number;
  speed: number;
  transferredBytes: number;
  totalBytes: number;
  direction: 'sending' | 'receiving';
  status: string;
};

type Peer = {
  socketId: string;
  peerData: { name: string; deviceType: string };
};

export default function App() {
  const [members, setMembers] = useState<Peer[]>([]);
  const [socket, setSocket] = useState<Socket | null>(null);
  const [myName, setMyName] = useState<string>('');
  
  const [transferState, setTransferState] = useState<TransferState | null>(null);
  const [incomingOffer, setIncomingOffer] = useState<{ meta: FileMeta, accept: () => void, reject: () => void } | null>(null);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const iceQueueRef = useRef<RTCIceCandidateInit[]>([]);

  useEffect(() => {
    const name = generateRandomName();
    const type = getDeviceType();
    setMyName(name);

    const s = io(SOCKET_URL);
    setSocket(s);

    s.on('connect', () => {
      // Join a default local room
      s.emit('join-room', 'local-network', { name, deviceType: type });
    });

    s.on('room-peers', (peers: Peer[]) => {
      setMembers(peers);
    });

    s.on('peer-joined', (peer: Peer) => {
      setMembers(prev => [...prev, peer]);
    });

    s.on('peer-left', (socketId: string) => {
      setMembers(prev => prev.filter(m => m.socketId !== socketId));
    });

    s.on('signal', async (data: { senderId: string, payload: any }) => {
      handleSignal(data.senderId, data.payload, s);
    });

    return () => {
      s.disconnect();
    };
  }, []);

  const handleSignal = async (fromId: string, signal: any, currentSocket: Socket) => {
    if (!pcRef.current && signal.sdp && signal.sdp.type === 'offer') {
      const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
      pcRef.current = pc;

      pc.onicecandidate = (e) => {
        if (e.candidate) {
          currentSocket.emit('signal', { targetId: fromId, payload: { ice: e.candidate } });
        }
      };

      pc.ondatachannel = (e) => {
        const dc = e.channel;
        dc.binaryType = 'arraybuffer';
        
        const receiver = new StreamReceiver(
          dc,
          (bytes, speed, meta) => {
            setTransferState({
              isTransferring: true,
              progress: (bytes / meta.size) * 100,
              speed,
              transferredBytes: bytes,
              totalBytes: meta.size,
              direction: 'receiving',
              status: 'Transferring...'
            });
          },
          (blobUrl, meta) => {
            if (blobUrl && meta) {
              const a = document.createElement('a');
              a.href = blobUrl;
              a.download = meta.name;
              a.click();
              URL.revokeObjectURL(blobUrl);
            }
            setTimeout(() => setTransferState(null), 2000);
            pc.close();
            pcRef.current = null;
          }
        );

        dc.onmessage = (event) => {
          receiver.handleMessage(event.data, async (meta) => {
            return new Promise((resolve, reject) => {
              setIncomingOffer({
                meta,
                accept: async () => {
                  setIncomingOffer(null);
                  try {
                    if ('showSaveFilePicker' in window) {
                      const handle = await (window as any).showSaveFilePicker({ suggestedName: meta.name });
                      const writable = await handle.createWritable();
                      resolve(writable);
                    } else {
                      resolve(null);
                    }
                  } catch (err) {
                    reject(err);
                  }
                },
                reject: () => {
                  setIncomingOffer(null);
                  reject(new Error('User rejected'));
                  pc.close();
                  pcRef.current = null;
                }
              });
            });
          });
        };
      };

      await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
      iceQueueRef.current.forEach(c => pc.addIceCandidate(new RTCIceCandidate(c)));
      iceQueueRef.current = [];

      const answer = await pc.createAnswer();
      currentSocket.emit('signal', { targetId: fromId, payload: { sdp: answer } });
      await pc.setLocalDescription(answer);
    } else if (pcRef.current) {
      if (signal.sdp && signal.sdp.type === 'answer') {
        await pcRef.current.setRemoteDescription(new RTCSessionDescription(signal.sdp));
        iceQueueRef.current.forEach(c => pcRef.current!.addIceCandidate(new RTCIceCandidate(c)));
        iceQueueRef.current = [];
      } else if (signal.ice) {
        if (pcRef.current.remoteDescription) {
          pcRef.current.addIceCandidate(new RTCIceCandidate(signal.ice));
        } else {
          iceQueueRef.current.push(signal.ice);
        }
      }
    }
  };

  const initiateTransfer = async (file: File, peerId: string) => {
    if (!socket) return;

    setTransferState({
      isTransferring: false,
      progress: 0,
      speed: 0,
      transferredBytes: 0,
      totalBytes: file.size,
      direction: 'sending',
      status: 'Connecting WebRTC...'
    });

    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    pcRef.current = pc;

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        socket.emit('signal', { targetId: peerId, payload: { ice: e.candidate } });
      }
    };

    const dc = pc.createDataChannel('file-transfer');
    dc.binaryType = 'arraybuffer';
    
    dc.onopen = () => {
      setTransferState(prev => prev ? { ...prev, status: 'Waiting for receiver to accept...' } : null);
      
      startStreamSender(
        file,
        dc,
        (bytes, speed) => {
          setTransferState({
            isTransferring: true,
            progress: (bytes / file.size) * 100,
            speed,
            transferredBytes: bytes,
            totalBytes: file.size,
            direction: 'sending',
            status: 'Transferring...'
          });
        },
        () => {
          setTimeout(() => setTransferState(null), 2000);
          pc.close();
          pcRef.current = null;
        }
      );
    };

    const offer = await pc.createOffer();
    socket.emit('signal', { targetId: peerId, payload: { sdp: offer } });
    await pc.setLocalDescription(offer);
  };

  const onDrop = (e: DragEvent<HTMLDivElement>, peerId: string) => {
    e.preventDefault();
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      initiateTransfer(e.dataTransfer.files[0], peerId);
    }
  };

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const getIcon = (deviceType: string) => {
    if (deviceType === 'Mobile') return <Smartphone className="w-8 h-8 text-white" />;
    if (deviceType === 'Mac' || deviceType === 'Windows' || deviceType === 'Linux') return <Laptop className="w-8 h-8 text-white" />;
    return <Monitor className="w-8 h-8 text-white" />;
  };

  return (
    <div className="min-h-screen bg-zinc-950 flex flex-col items-center justify-center p-4 font-sans text-zinc-100 overflow-hidden relative">
      
      {/* Radar Background */}
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none opacity-50">
        <div className="radar-ring" style={{ animationDelay: '0s' }}></div>
        <div className="radar-ring" style={{ animationDelay: '1s' }}></div>
        <div className="radar-ring" style={{ animationDelay: '2s' }}></div>
        <div className="radar-ring" style={{ animationDelay: '3s' }}></div>
      </div>

      <div className="absolute bottom-8 text-center w-full text-zinc-500 text-sm">
        You are known as <strong className="text-white">{myName}</strong>
      </div>

      {incomingOffer && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
          <div className="bg-zinc-900 border border-zinc-800 p-8 rounded-2xl shadow-2xl max-w-sm w-full text-center">
            <FileUp className="w-16 h-16 text-blue-500 mx-auto mb-4" />
            <h2 className="text-xl font-bold text-white mb-2">Incoming File</h2>
            <p className="text-zinc-400 mb-6">
              <span className="text-white font-medium">{incomingOffer.meta.name}</span> <br/>
              ({formatBytes(incomingOffer.meta.size)})
            </p>
            <div className="flex space-x-3">
              <button 
                onClick={incomingOffer.reject}
                className="flex-1 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 py-3 rounded-xl transition-colors font-medium"
              >
                Decline
              </button>
              <button 
                onClick={incomingOffer.accept}
                className="flex-1 bg-blue-600 hover:bg-blue-500 text-white py-3 rounded-xl transition-colors font-medium"
              >
                Accept & Save
              </button>
            </div>
          </div>
        </div>
      )}

      {transferState && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/70 backdrop-blur-sm">
          <div className="bg-zinc-900 border border-zinc-800 p-8 rounded-3xl max-w-md w-full shadow-2xl">
            <div className="flex justify-between items-center mb-6">
              <div>
                <h3 className="text-lg font-medium text-white">
                  {transferState.direction === 'sending' ? 'Sending...' : 'Receiving...'}
                </h3>
                <p className="text-blue-400 text-sm font-semibold mt-1">
                  {transferState.status}
                </p>
                <p className="text-zinc-400 text-xs mt-1">
                  {formatBytes(transferState.transferredBytes)} of {formatBytes(transferState.totalBytes)}
                </p>
              </div>
              <div className="text-right">
                <div className="text-2xl font-bold text-blue-400">
                  {transferState.progress.toFixed(0)}%
                </div>
                <p className="text-zinc-500 text-sm">{formatBytes(transferState.speed)}/s</p>
              </div>
            </div>
            
            <div className="w-full bg-zinc-950 rounded-full h-4 mb-2 overflow-hidden border border-zinc-800">
              <div 
                className="bg-blue-500 h-full rounded-full transition-all duration-300 ease-out" 
                style={{ width: `${transferState.progress}%` }}
              ></div>
            </div>
          </div>
        </div>
      )}

      <div className="relative z-10 w-full max-w-4xl min-h-[60vh] flex flex-wrap justify-center items-center gap-12 p-8">
        {members.length === 0 ? (
          <div className="text-center">
            <h2 className="text-2xl font-bold text-white mb-2">No Devices Found</h2>
            <p className="text-zinc-400">Open this page on another device to send files.</p>
          </div>
        ) : (
          members.map(m => (
            <div
              key={m.socketId}
              className="flex flex-col items-center cursor-pointer group relative"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => onDrop(e, m.socketId)}
              onClick={() => {
                const input = document.createElement('input');
                input.type = 'file';
                input.onchange = (e: any) => {
                  if (e.target.files && e.target.files.length > 0) {
                    initiateTransfer(e.target.files[0], m.socketId);
                  }
                };
                input.click();
              }}
            >
              <div className="w-24 h-24 rounded-full bg-zinc-800/80 border-2 border-zinc-700/50 flex items-center justify-center mb-4 group-hover:border-blue-500/80 group-hover:bg-zinc-800 transition-all shadow-xl group-hover:shadow-[0_0_30px_rgba(59,130,246,0.3)] relative overflow-hidden">
                {getIcon(m.peerData.deviceType)}
                
                {/* Plus icon on hover to indicate action */}
                <div className="absolute inset-0 bg-blue-500/20 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                  <FileUp className="w-8 h-8 text-white drop-shadow-md" />
                </div>
              </div>
              <div className="text-center">
                <p className="font-bold text-zinc-100">{m.peerData.name}</p>
                <p className="text-xs text-zinc-500">{m.peerData.deviceType}</p>
              </div>
            </div>
          ))
        )}
      </div>

    </div>
  );
}
