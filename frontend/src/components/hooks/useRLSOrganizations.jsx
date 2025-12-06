import { useQuery } from "@tanstack/react-query";
import { base44 } from "@/api/base44Client";

/**
 * RLS-safe hook for fetching organizations
 * - Admin users see all organizations
 * - Regular users only see organizations they created
 */
export function useRLSOrganizations() {
  return useQuery({
    queryKey: ["organizationsRLS"],
    queryFn: async () => {
      const user = await base44.auth.me();
      const isAdmin = user?.email === "buckeye7066@gmail.com";

      if (isAdmin) {
        return base44.entities.Organization.list("-created_date");
      }

      return base44.entities.Organization.filter(
        { created_by: user.email },
        "-created_date"
      );
    },
  });
}