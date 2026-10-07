/** What a stored recording asks of the flow page: the query that names it, which the page reads and removes. */
export const RECORDING_QUERY_PARAM = "recording";

/** The flow page opened to send a stored recording: "Skapa dokument" on an unsent recording in the flow list. */
export const sendRecordingAddress = (flowId: string, recordingId: string) => `/flows/${flowId}?${RECORDING_QUERY_PARAM}=${recordingId}`;
