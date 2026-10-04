"""Leave an upload half-way, from inside the image (B4.2 check 9): send a request's head and some of its body to the module over loopback,
then close the connection with a reset, as a browser tab does that is closed in the middle of an upload.

    python - '{"port": 3001, "send": "POST ... HTTP/1.1\\r\\n...", "chunks": 150, "hold": 5}' < abandon_upload.py     (docker exec -i, standard library only)

``send`` is the request line, the headers and the start of the body; ``chunks`` is how many MiB of body follow, and ``hold`` the seconds the
connection stays open after the last of them, so that the caller can see the module holding the upload before it is left. Run on the host, the reset
has to cross the port forwarder of the host's Docker, which does not always pass it on: the module is then still reading, rightly, an
upload that nobody told it was abandoned. Over loopback the reset is the module's own.
"""

import json
import socket
import struct
import sys
import time

spec = json.loads(sys.argv[1])
sock = socket.create_connection(("127.0.0.1", spec["port"]), timeout=60)
sock.sendall(spec["send"].encode())
chunk = bytes(1024 * 1024)
for _ in range(spec["chunks"]):
    sock.sendall(chunk)
time.sleep(spec.get("hold", 0))
sock.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0))
sock.close()
