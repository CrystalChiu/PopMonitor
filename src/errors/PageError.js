class PageError extends Error {
    constructor(message) {
        super(message);
        this.name = "PageError";
    }
}
  
module.exports = PageError;