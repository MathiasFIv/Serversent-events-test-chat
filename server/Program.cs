var builder = WebApplication.CreateBuilder(args);
builder.Services.Configure<HostOptions>(options =>
{
    options.ShutdownTimeout = TimeSpan.FromSeconds(0);
});
builder.Services.AddControllers();
builder.Services.AddCors();
builder.Services.AddOpenApiDocument();


var app = builder.Build();

app.MapGet("/", () => "Hello World!");
app.UseCors(policy => policy.AllowAnyOrigin().AllowAnyMethod().AllowAnyHeader());
app.MapControllers();
app.UseOpenApi();
app.UseSwaggerUi();


app.Run();
