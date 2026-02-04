/**
 * Admin UI for Bulk Grant Eligibility Updates
 * Allows admins to update grant descriptions, eligibility criteria, and selection criteria in bulk
 */

import React, { useState } from 'react';
import { Button, Input, Select, Table, Modal, message, Spin, Tag } from 'antd';
import { UploadOutlined, EditOutlined, CheckOutlined } from '@ant-design/icons';
import './BulkGrantEligibilityUpdater.css';

const BulkGrantEligibilityUpdater = () => {
    const [grants, setGrants] = useState([]);
    const [selectedGrants, setSelectedGrants] = useState([]);
    const [loading, setLoading] = useState(false);
    const [editModal, setEditModal] = useState(false);
    const [searchTerm, setSearchTerm] = useState('');
    const [filterCategory, setFilterCategory] = useState('all');
    const [bulkEditData, setBulkEditData] = useState({
          programDescription: '',
          eligibilitySummary: '',
          selectionCriteria: '',
    });

    // Fetch grants from API
    const fetchGrants = async () => {
          setLoading(true);
          try {
                  const response = await fetch('/api/grants?limit=1000', {
                            headers: {
                                        'Authorization': `Bearer ${localStorage.getItem('grantflow:access-token')}`,
                                        'Content-Type': 'application/json'
                            }
                  });
                  const data = await response.json();
                  setGrants(data.grants || []);
                  message.success('Grants loaded successfully');
          } catch (error) {
                  message.error('Failed to load grants: ' + error.message);
          } finally {
                  setLoading(false);
          }
    };

    // Filter grants
    const filteredGrants = grants.filter(grant => {
          const matchesSearch = grant.title.toLowerCase().includes(searchTerm.toLowerCase()) ||
                                     grant.funder.toLowerCase().includes(searchTerm.toLowerCase());
          const matchesCategory = filterCategory === 'all' || 
                                       grant.category === filterCategory ||
                                       (filterCategory === 'missing_eligibility' && !grant.eligibility_summary);
          return matchesSearch && matchesCategory;
    });

    // Apply bulk updates to selected grants
    const applyBulkUpdate = async () => {
          if (selectedGrants.length === 0) {
                  message.warning('Please select at least one grant');
                  return;
          }

          setLoading(true);
          try {
                  const updatePromises = selectedGrants.map(grantId => {
                            return fetch(`/api/grants/${grantId}`, {
                                        method: 'PUT',
                                        headers: {
                                                      'Authorization': `Bearer ${localStorage.getItem('grantflow:access-token')}`,
                                                      'Content-Type': 'application/json'
                                        },
                                        body: JSON.stringify({
                                                      ...bulkEditData,
                                                      updated_date: new Date().toISOString(),
                                                      updated_by: localStorage.getItem('user:email')
                                        })
                            });
                  });

            await Promise.all(updatePromises);
                  message.success(`Successfully updated ${selectedGrants.length} grants`);
                  setEditModal(false);
                  setSelectedGrants([]);
                  setBulkEditData({
                            programDescription: '',
                            eligibilitySummary: '',
                            selectionCriteria: '',
                  });
                  await fetchGrants();
          } catch (error) {
                  message.error('Failed to update grants: ' + error.message);
          } finally {
                  setLoading(false);
          }
    };

    const columns = [
      {
              title: 'Grant Title',
              dataIndex: 'title',
              key: 'title',
              width: '30%',
              render: (text, record) => (
                        <div className="grant-title-cell">
                                  <strong>{text}</strong>strong>
                                  <br />
                                  <small>{record.funder}</small>small>
                        </div>div>
                      )
      },
      {
              title: 'Category',
              dataIndex: 'category',
              key: 'category',
              width: '15%',
              render: (text) => <Tag color="blue">{text || 'uncategorized'}</Tag>Tag>
                },
      {
              title: 'Eligibility Status',
              key: 'eligibility_status',
              width: '20%',
              render: (_, record) => {
                        const hasDescription = !!record.program_description;
                        const hasSummary = !!record.eligibility_summary;
                        const hasCriteria = !!record.selection_criteria;
                        
                        return (
                                    <div className="eligibility-status">
                                      {hasDescription && <Tag color="green"><CheckOutlined /> Description</Tag>Tag>}
                                      {hasSummary && <Tag color="green"><CheckOutlined /> Summary</Tag>Tag>}
                                      {hasCriteria && <Tag color="green"><CheckOutlined /> Criteria</Tag>Tag>}
                                      {!hasDescription && !hasSummary && !hasCriteria && (
                                                    <Tag color="red">Missing All</Tag>Tag>
                                                )}
                                    </div>div>
                                  );
              }
        },
      {
              title: 'Last Updated',
              dataIndex: 'updated_date',
              key: 'updated_date',
              width: '15%',
              render: (date) => date ? new Date(date).toLocaleDateString() : 'Never'
      }
        ];
  
    return (
          <div className="bulk-grant-updater">
                <div className="header">
                        <h2><EditOutlined /> Bulk Grant Eligibility Updates</h2>h2>
                        <p>Update program descriptions, eligibility criteria, and selection criteria for multiple grants at once</p>p>
                </div>div>
          
                <div className="controls">
                        <Input.Search
                                    placeholder="Search grants by title or funder..."
                                    value={searchTerm}
                                    onChange={(e) => setSearchTerm(e.target.value)}
                                    style={{ marginRight: '10px', width: '300px' }}
                                  />
                        
                        <Select
                                    style={{ width: '200px', marginRight: '10px' }}
                                    value={filterCategory}
                                    onChange={setFilterCategory}
                                    options={[
                                      { label: 'All Categories', value: 'all' },
                                      { label: 'Scholarship', value: 'scholarship' },
                                      { label: 'Education', value: 'education' },
                                      { label: 'Housing', value: 'housing' },
                                      { label: 'Missing Eligibility', value: 'missing_eligibility' }
                                                ]}
                                  />
                
                        <Button type="primary" onClick={fetchGrants} loading={loading}>
                                  <UploadOutlined /> Load Grants
                        </Button>Button>
                </div>div>
          
                <Spin spinning={loading}>
                        <div className="grants-table">
                                  <Table
                                                columns={columns}
                                                dataSource={filteredGrants.map(g => ({ ...g, key: g.id }))}
                                                rowSelection={{
                                                                selectedRowKeys: selectedGrants,
                                                                onChange: setSelectedGrants,
                                                }}
                                                pagination={{ pageSize: 20 }}
                                                size="small"
                                              />
                        </div>div>
                </Spin>Spin>
          
                <div className="actions">
                        <Button 
                                    type="primary" 
                          danger 
                                    onClick={() => setEditModal(true)}
                                    disabled={selectedGrants.length === 0}
                                  >
                                  Edit {selectedGrants.length} Selected Grants
                        </Button>Button>
                </div>div>
          
                <Modal
                          title="Bulk Edit Grant Eligibility"
                          open={editModal}
                          onOk={applyBulkUpdate}
                          onCancel={() => setEditModal(false)}
                          width={800}
                          okText="Apply to Selected Grants"
                          okButtonProps={{ danger: true }}
                        >
                        <div className="bulk-edit-form">
                                  <div className="form-group">
                                              <label>Program Description</label>label>
                                              <textarea
                                                              value={bulkEditData.programDescription}
                                                              onChange={(e) => setBulkEditData({...bulkEditData, programDescription: e.target.value})}
                                                              placeholder="Enter program description..."
                                                              rows={3}
                                                            />
                                  </div>div>
                        
                                  <div className="form-group">
                                              <label>Eligibility Summary</label>label>
                                              <textarea
                                                              value={bulkEditData.eligibilitySummary}
                                                              onChange={(e) => setBulkEditData({...bulkEditData, eligibilitySummary: e.target.value})}
                                                              placeholder="Enter eligibility criteria summary..."
                                                              rows={4}
                                                            />
                                  </div>div>
                        
                                  <div className="form-group">
                                              <label>Selection Criteria</label>label>
                                              <textarea
                                                              value={bulkEditData.selectionCriteria}
                                                              onChange={(e) => setBulkEditData({...bulkEditData, selectionCriteria: e.target.value})}
                                                              placeholder="Enter selection criteria..."
                                                              rows={4}
                                                            />
                                  </div>div>
                        
                                  <div className="preview">
                                              <h4>Preview (will be applied to {selectedGrants.length} grants):</h4>h4>
                                    {Object.entries(bulkEditData).map(([key, value]) => (
                                        value && (
                                                          <div key={key} className="preview-item">
                                                                            <strong>{key.replace(/([A-Z])/g, ' $1').trim()}:</strong>strong>
                                                                            <p>{value}</p>p>
                                                          </div>div>
                                                        )
                                      ))}
                                  </div>div>
                        </div>div>
                </Modal>Modal>
          </div>div>
        );
};

export default BulkGrantEligibilityUpdater;</div>
