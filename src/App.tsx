import React, { useEffect, useState, useRef, DragEvent } from 'react';
import Pusher, { PresenceChannel } from 'pusher-js';
import { UploadCloud, CheckCircle, AlertCircle, Loader2, FileUp, Laptop, Smartphone, Radar } from 'lucide-react';
import { startStreamSender, CHUNK_SIZE } from './utils/streamSender';
import { StreamReceiver, FileMeta } from './utils/streamReceiver';

type TransferState = {
  isTransferring: boolean;
  progress: number;
  speed: number;
  transferredBytes: number;
  totalBytes: number;
  direction: 'sending' | 'receiving';
};

export default function App() {
  const [members, setMembers] = useState<any[]>([]);
  const [channel, setChannel] = useState<PresenceChannel | null>(null);
  const [myId, setMyId] = useState<string | null>(null);
  const [selectedPeerId, setSelectedPeerId] = useState<string | null>(null);
  const [transferState, setTransferState] = useState<TransferState | null>(null);
  
  const [incomingOffer, setIncomingOffer] = useState<{ meta: FileMeta, accept: () => void, reject: () => void } | null>(null);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const iceQueueRef = useRef<RTCIceCandidateInit[]>([]);

  useEffect(() => {
    let pusherClient: Pusher;

    fetch('/api/auth')
      .then(res => res.json())
      .then(data => {
        if (data.error) {
          console.error("Auth error:", data.error);
          return;
        }

        pusherClient = new Pusher(import.meta.env.VITE_PUSHER_APP_KEY, {
          cluster: import.meta.env.VITE_PUSHER_CLUSTER,
          authEndpoint: '/api/auth',
        });
        
        const presenceChannel = pusherClient.subscribe(data.channel_name) as PresenceChannel;
        setChannel(presenceChannel);

        presenceChannel.bind('pusher:subscription_succeeded', (membersData: any) => {
          setMyId(membersData.myID);
          const membersArray: any[] = [];
          membersData.each((member: any) => membersArray.push(member));
          setMembers(membersArray.filter(m => m.id !== membersData.myID));
        });

        presenceChannel.bind('pusher:member_added', (member: any) => {
          setMembers(prev => [...prev, member]);
        });

        presenceChannel.bind('pusher:member_removed', (member: any) => {
          setMembers(prev => prev.filter(m => m.id !== member.id));
          if (selectedPeerId === member.id) setSelectedPeerId(null);
        });

        presenceChannel.bind('client-signal', async (signalData: any) => {
          if (signalData.to === presenceChannel.members.myID) {
            handleSignal(signalData.from, signalData.signal);
          }
        });
      })
      .catch(console.error);

    return () => {
      if (pusherClient) pusherClient.disconnect();
    };
  }, []);

  const handleSignal = async (fromId: string, signal: any) => {
    if (!pcRef.current && signal.sdp && signal.sdp.type === 'offer') {
      // Incoming WebRTC connection
      const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
      pcRef.current = pc;

      pc.onicecandidate = (e) => {
        if (e.candidate && channel) {
          channel.trigger('client-signal', { to: fromId, from: myId, signal: { ice: e.candidate } });
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
              direction: 'receiving'
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
                      // Fallback
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
      
      // Process queued ICE candidates
      iceQueueRef.current.forEach(c => pc.addIceCandidate(new RTCIceCandidate(c)));
      iceQueueRef.current = [];

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      channel!.trigger('client-signal', { to: fromId, from: myId, signal: { sdp: pc.localDescription } });
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

  const initiateTransfer = async (file: File) => {
    if (!selectedPeerId || !channel) return;

    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    pcRef.current = pc;

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        channel.trigger('client-signal', { to: selectedPeerId, from: myId, signal: { ice: e.candidate } });
      }
    };

    const dc = pc.createDataChannel('file-transfer');
    dc.binaryType = 'arraybuffer';
    
    dc.onopen = () => {
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
            direction: 'sending'
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
    await pc.setLocalDescription(offer);
    channel.trigger('client-signal', { to: selectedPeerId, from: myId, signal: { sdp: pc.localDescription } });
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      initiateTransfer(e.dataTransfer.files[0]);
    }
  };

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  return (
    <div className="min-h-screen bg-zinc-950 flex flex-col items-center justify-center p-4 font-sans text-zinc-100">
      
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

      <div className="w-full max-w-4xl grid md:grid-cols-2 gap-8">
        
        {/* Radar View */}
        <div className="bg-zinc-900/50 border border-zinc-800/50 rounded-3xl p-8 relative overflow-hidden flex flex-col items-center justify-center min-h-[400px]">
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,_var(--tw-gradient-stops))] from-blue-900/20 via-zinc-900/5 to-transparent"></div>
          
          <Radar className="w-12 h-12 text-blue-500/50 mb-6 animate-pulse" />
          <h2 className="text-2xl font-bold text-white mb-2">Nearby Devices</h2>
          <p className="text-zinc-400 text-sm mb-8">Select a device to share files on your Wi-Fi network</p>
          
          <div className="w-full space-y-3 z-10">
            {members.length === 0 ? (
              <div className="text-center p-6 bg-zinc-800/30 border border-zinc-700/50 rounded-2xl">
                <Loader2 className="w-6 h-6 animate-spin text-zinc-500 mx-auto mb-3" />
                <p className="text-zinc-500">Scanning for peers...</p>
              </div>
            ) : (
              members.map(m => (
                <button
                  key={m.id}
                  onClick={() => setSelectedPeerId(m.id)}
                  className={`w-full flex items-center p-4 rounded-2xl transition-all ${
                    selectedPeerId === m.id 
                      ? 'bg-blue-600/20 border-blue-500/50 shadow-[0_0_15px_rgba(59,130,246,0.15)]' 
                      : 'bg-zinc-800/50 border-zinc-700/50 hover:bg-zinc-800'
                  } border`}
                >
                  <div className="bg-zinc-700/50 p-3 rounded-xl mr-4">
                    {m.info.deviceType === 'Smartphone' ? <Smartphone className="w-6 h-6 text-blue-400" /> : <Laptop className="w-6 h-6 text-blue-400" />}
                  </div>
                  <div className="text-left">
                    <p className="font-medium text-zinc-100">{m.info.deviceType} {m.id}</p>
                    <p className="text-xs text-zinc-500">Ready to receive</p>
                  </div>
                  {selectedPeerId === m.id && (
                    <CheckCircle className="w-5 h-5 text-blue-400 ml-auto" />
                  )}
                </button>
              ))
            )}
          </div>
        </div>

        {/* Transfer Interface */}
        <div className="bg-zinc-900 border border-zinc-800 rounded-3xl p-8 flex flex-col justify-center">
          
          {!selectedPeerId && !transferState ? (
            <div className="text-center text-zinc-500 py-12">
              <Laptop className="w-16 h-16 opacity-20 mx-auto mb-4" />
              <p>Select a nearby device to start sharing</p>
            </div>
          ) : !transferState ? (
            <div 
              className="border-2 border-dashed border-blue-500/30 hover:border-blue-500/50 bg-blue-500/5 hover:bg-blue-500/10 rounded-3xl p-12 text-center cursor-pointer transition-all h-full flex flex-col justify-center items-center"
              onDragOver={(e) => e.preventDefault()}
              onDrop={onDrop}
              onClick={() => document.getElementById('fileInput')?.click()}
            >
              <FileUp className="w-16 h-16 text-blue-400 mx-auto mb-4" />
              <p className="text-zinc-300 font-medium text-lg">Drop any file here</p>
              <p className="text-zinc-500 mt-2">Up to 20GB Supported</p>
              <input
                type="file"
                id="fileInput"
                className="hidden"
                onChange={(e) => e.target.files && initiateTransfer(e.target.files[0])}
              />
            </div>
          ) : (
            <div className="bg-zinc-800/50 border border-zinc-700/50 rounded-3xl p-8 w-full">
              <div className="flex justify-between items-center mb-6">
                <div>
                  <h3 className="text-lg font-medium text-white">
                    {transferState.direction === 'sending' ? 'Sending...' : 'Receiving...'}
                  </h3>
                  <p className="text-zinc-400 text-sm mt-1">
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
              <div className="flex justify-between text-xs text-zinc-500 mt-4">
                <span>Direct Disk Stream</span>
                <span>{transferState.progress === 100 ? 'Complete' : 'Transferring'}</span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
