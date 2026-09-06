export interface FileMeta {
  name: string;
  size: number;
  mime: string;
}

export class StreamReceiver {
  private meta: FileMeta | null = null;
  private receivedBytes = 0;
  private startTime = 0;
  
  private writableStream: any = null;
  private receiveBuffer: ArrayBuffer[] = [];
  private useFallback = false;

  constructor(
    private channel: RTCDataChannel,
    private onProgress: (bytes: number, speed: number, meta: FileMeta) => void,
    private onComplete: (blobUrl?: string, meta?: FileMeta) => void
  ) {}

  public async handleMessage(data: string | ArrayBuffer, promptUserForSave: (meta: FileMeta) => Promise<any>) {
    if (typeof data === 'string') {
      const msg = JSON.parse(data);
      if (msg.type === 'file-meta') {
        this.meta = { name: msg.name, size: msg.size, mime: msg.mime };
        this.receivedBytes = 0;
        this.startTime = Date.now();
        this.receiveBuffer = [];
        
        try {
          this.writableStream = await promptUserForSave(this.meta);
          this.useFallback = !this.writableStream;
          // Send accept to sender so they start streaming chunks
          this.channel.send(JSON.stringify({ type: 'accept' }));
        } catch (e) {
          console.error("Save rejected or failed", e);
          this.channel.send(JSON.stringify({ type: 'reject' }));
          this.useFallback = false;
        }
      } else if (msg.type === 'eof') {
        if (this.useFallback && this.receiveBuffer.length > 0) {
          const blob = new Blob(this.receiveBuffer, { type: this.meta?.mime });
          const url = URL.createObjectURL(blob);
          this.onComplete(url, this.meta!);
          this.receiveBuffer = [];
        } else if (this.writableStream) {
          await this.writableStream.close();
          this.onComplete(undefined, this.meta!);
        }
        this.meta = null;
      }
    } else {
      // Binary chunk
      this.receivedBytes += data.byteLength;
      
      if (this.useFallback) {
        this.receiveBuffer.push(data);
      } else if (this.writableStream) {
        await this.writableStream.write(data);
      }

      if (this.meta) {
        const speed = this.receivedBytes / ((Date.now() - this.startTime) / 1000);
        this.onProgress(this.receivedBytes, speed, this.meta);
      }
    }
  }
}
