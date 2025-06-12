class HighTrafficError extends Error {
    constructor(message) {
        super(message);
        this.name = "HighTrafficError";
    }
}

module.exports = HighTrafficError;