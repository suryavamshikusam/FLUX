export const CHUNK_SIZE = 64 * 1024; // 64 KB
export const MAX_BUFFER = 8 * 1024 * 1024; // 8 MB

export function startStreamSender(
  file: File,
  channel: RTCDataChannel,
  onProgress: (bytesTransferred: number, speed: number) => void,
  onComplete: () => void
) {
  // 1. Send metadata
  channel.send(JSON.stringify({ type: 'file-meta', name: file.name, size: file.size, mime: file.type }));

  // 2. Wait for accept
  const messageHandler = (event: MessageEvent) => {
    if (typeof event.data === 'string') {
      const msg = JSON.parse(event.data);
      if (msg.type === 'accept') {
        // Remove this listener, start sending
        channel.removeEventListener('message', messageHandler);
        startSending();
      } else if (msg.type === 'reject') {
        channel.removeEventListener('message', messageHandler);
        // Handle rejection (optional)
      }
    }
  };
  channel.addEventListener('message', messageHandler);

  function startSending() {
    let offset = 0;
    const startTime = Date.now();

    channel.bufferedAmountLowThreshold = MAX_BUFFER / 2;

    const readSlice = (currentOffset: number) => {
      if (channel.readyState !== 'open') return;
      
      const slice = file.slice(currentOffset, currentOffset + CHUNK_SIZE);
      const reader = new FileReader();

      reader.onload = (e) => {
        if (channel.readyState !== 'open') return;
        channel.send(e.target!.result as ArrayBuffer);
        offset += slice.size;

        const speed = offset / ((Date.now() - startTime) / 1000);
        onProgress(offset, speed);

        if (offset < file.size) {
          if (channel.bufferedAmount > MAX_BUFFER) {
            channel.onbufferedamountlow = () => {
              channel.onbufferedamountlow = null;
              readSlice(offset);
            };
          } else {
            readSlice(offset);
          }
        } else {
          channel.send(JSON.stringify({ type: 'eof' }));
          onComplete();
        }
      };
      reader.readAsArrayBuffer(slice);
    };

    readSlice(0);
  }
}
