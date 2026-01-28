namespace server.Entities;

public class ClientInfo
{
    public Guid Id { get; set; }

    // Stable id provided by the browser (stored in localStorage) so reconnects keep identity.
    public string UserId { get; set; } = "";

    public string Username { get; set; } = "";

    public System.IO.Stream Stream { get; set; } = default!;

    // Typing indicator state.
    public DateTimeOffset? LastTypingUtc { get; set; }
    public bool IsTyping { get; set; }
}