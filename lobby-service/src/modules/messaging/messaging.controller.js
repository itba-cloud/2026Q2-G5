/**
 * MessagingController: Broadcasts operator announcements to every world.
 */
export class MessagingController {
  /**
   * @param {import('./AnnouncementPublisher.js').AnnouncementPublisher} publisher
   * @param {number} maxLength
   */
  constructor(publisher, maxLength = 200) {
    this.publisher = publisher;
    this.maxLength = maxLength;
  }

  postAnnouncement = async (req, res, next) => {
    try {
      const message = (req.body?.message || '').toString().replace(/\s+/g, ' ').trim();

      if (!message) {
        res.status(400).json({ error: 'A non-empty "message" field is required' });
        return;
      }

      const truncated = message.slice(0, this.maxLength);
      const published = await this.publisher.announce(truncated);

      if (!published) {
        // The bus being down is an infrastructure state, not a bad request.
        res.status(503).json({
          error: 'Messaging bus unavailable',
          detail: 'The Lobby could not reach Redis. Announcements are disabled.',
        });
        return;
      }

      res.json({
        status: 'published',
        message: truncated,
        truncated: truncated.length < message.length,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      next(err);
    }
  };
}
