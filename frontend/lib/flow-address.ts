/** What a stored recording asks of the flow page: the query that names it, which the page reads and removes. */
export const RECORDING_QUERY_PARAM = "recording";
/** The same for a recording to record on in. */
export const CONTINUE_QUERY_PARAM = "continue";

/** The flow page opened to send a stored recording: "Skapa dokument" on an unsent recording in the flow list. */
export const sendRecordingAddress = (flowId: string, recordingId: string) => `/flows/${flowId}?${RECORDING_QUERY_PARAM}=${recordingId}`;

/** The flow page opened to record on in a cut-off recording: "Fortsätt spela in" on it in the flow list. */
export const continueRecordingAddress = (flowId: string, recordingId: string) => `/flows/${flowId}?${CONTINUE_QUERY_PARAM}=${recordingId}`;
