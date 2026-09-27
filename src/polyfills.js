// Safari (seen on iOS 26.7) cannot iterate a ReadableStream with `for await`,
// which PDF.js uses in getTextContent. Without this every PDF fails there with
// "undefined is not a function (near '...e of t...')". PDF.js's legacy build
// polyfills its other new methods itself (Promise.try, toHex, getOrInsertComputed).
if (typeof ReadableStream !== 'undefined' && !ReadableStream.prototype[Symbol.asyncIterator]) {
  ReadableStream.prototype[Symbol.asyncIterator] = async function* () {
    const reader = this.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        yield value;
      }
    } finally {
      reader.releaseLock();
    }
  };
}
