// Deliberately unavailable until a verified identity boundary and commerce handler are wired.
export const dynamic = "force-dynamic";

function unavailable(): Response {
  return Response.json(
    {
      code: "shopping_unavailable",
      message: "The shopping service is not connected.",
    },
    { status: 503, headers: { "Cache-Control": "no-store" } },
  );
}

export const GET = unavailable;
export const POST = unavailable;
export const PUT = unavailable;
export const PATCH = unavailable;
export const DELETE = unavailable;
