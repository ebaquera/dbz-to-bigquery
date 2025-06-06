
/* *
 * This function handles 'c' (create), 'u' (update), 'd' (delete), and 'r' (snapshot read)
 * operations from Debezium.
 *
 * @param {string} inJson The incoming JSON string from Pub/Sub (Debezium event).
 * @return {string} A JSON string representing the row data for BigQuery.
 */
function process(inJson) {
  try {
    const data = JSON.parse(inJson);

    // Ensure it's a valid Debezium payload structure
    if (!data || !data.payload || !data.payload.op) {
      // Log or handle unexpected message format if necessary
      // console.warn('Received unexpected Pub/Sub message format:', inJson);
      return JSON.stringify({}); // Return an empty object to filter out invalid messages
    }

    const payload = data.payload;
    const op = payload.op; // Operation type: 'c', 'u', 'd', 'r'
    const ts_ms = payload.ts_ms; // Event timestamp in milliseconds

    let outputRecord = {};

    switch (op) {
      case 'c': // Create (Insert)
      case 'u': // Update
      case 'r': // Read (Snapshot)
        // For 'c', 'u', 'r', the 'after' field contains the new state of the row
        if (payload.after) {
          outputRecord = payload.after;
        }
        break;
      case 'd': // Delete
        if (payload.before) {
            outputRecord = payload.before; // Store the state before deletion
        }
        outputRecord._deleted = true; //Indicate that it was a delete
        break;
      default:
        return JSON.stringify({});
    }

    // Add Debezium metadata fields directly to the BigQuery record
    outputRecord._op = op;
    outputRecord._ts_ms = ts_ms;
    outputRecord._source_ts_ms = payload.source.ts_ms; // Timestamp of the change in the source DB
N

    return JSON.stringify(outputRecord);

  } catch (e) {
    // Log parsing errors to Stackdriver Logging
    // console.error('Error parsing JSON or processing message:', e.message, 'Input:', inJson);
    return JSON.stringify({}); // Return empty object for errors, effectively dropping malformed messages
  }
}
