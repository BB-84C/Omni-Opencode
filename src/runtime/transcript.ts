export type RuntimeTranscript = {
  chunks: string[]
  text: string
}

export function createTranscript(): RuntimeTranscript {
  return {
    chunks: [],
    text: "",
  }
}

export function appendTranscriptChunk(transcript: RuntimeTranscript, chunk: string): void {
  transcript.chunks.push(chunk)
  transcript.text += chunk
}
