import React, { useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { FileText } from 'lucide-react';
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';

export default function ProjectsTab({ projects, organizations }) {
  const organizationMap = useMemo(() => {
    const map = new Map();
    organizations.forEach(org => {
      map.set(org.id, org);
    });
    return map;
  }, [organizations]);

  return (
    <Card className="shadow-lg border-0">
      <CardHeader>
        <CardTitle>All Projects</CardTitle>
      </CardHeader>
      <CardContent>
        {projects.length === 0 ? (
          <div className="text-center py-12 text-slate-500">
            <FileText className="w-16 h-16 mx-auto mb-4 text-slate-300" />
            <p className="font-semibold">No Projects Found</p>
            <p className="text-sm mb-4">Create a project to start tracking work and billing.</p>
            <Link to={createPageUrl("NewProject")}>
              <Button>Create Your First Project</Button>
            </Link>
          </div>
        ) : (
          <div className="space-y-4">
            {projects.map(project => {
              const org = organizationMap.get(project.organization_id);
              return (
                <div 
                  key={project.id} 
                  className="p-4 border rounded-lg hover:bg-slate-50 transition-colors"
                  data-testid={`project-${project.id}`}
                >
                  <div className="flex justify-between items-start">
                    <div>
                      <h4 className="font-bold text-lg text-slate-900">{project.project_name}</h4>
                      <p className="text-sm text-slate-600">{org?.name || 'Unknown Client'}</p>
                    </div>
                    <Badge variant={project.status === 'active' ? 'default' : 'secondary'}>{project.status}</Badge>
                  </div>
                  <div className="mt-3 flex items-center justify-between text-sm">
                    <span className="text-slate-500">
                      Pricing: <span className="font-medium text-slate-700">
                        {project.pricing_model?.replace(/_/g, ' ')}
                      </span>
                    </span>
                    <Link to={createPageUrl(`ProjectDetail?id=${project.id}`)}>
                      <Button 
                        variant="outline" 
                        size="sm"
                        data-testid={`view-project-${project.id}`}
                      >
                        View Details
                      </Button>
                    </Link>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}