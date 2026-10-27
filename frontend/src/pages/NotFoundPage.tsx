
import { Link } from "react-router-dom";
import { FileQuestion, Home } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/shared/indicators";

export default function NotFoundPage() {
  return (
    <div className="flex flex-col items-center justify-center py-16">
      <EmptyState
        icon={<FileQuestion className="h-5 w-5" />}
        title="Page not found"
        message="The page you requested does not exist in this application."
        action={
          <Button asChild size="sm">
            <Link to="/">
              <Home className="h-3.5 w-3.5" /> Back to overview
            </Link>
          </Button>
        }
      />
    </div>
  );
}
